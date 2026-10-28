// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {IAssetRegistry} from "../interfaces/IAssetRegistry.sol";

/// @title AssetApprovalDAO
/// @notice Council DAO that verifies company assets. Members vote one-member-one-vote on proposals to approve,
///         reject, suspend, reinstate, retire or revalue assets, and on adding or removing members.
/// @dev - A proposal passes when votes cast >= quorum and For / (For + Against) >= approvalThresholdBps.
///      - It can execute early once For alone reaches the threshold of all eligible members (outcome decided).
///      - Only members who joined at or before a proposal's creation can vote on it.
///      - One open proposal per asset at a time, so conflicting actions cannot race.
///      - Voting settings are held by DEFAULT_ADMIN_ROLE (intended: a Timelock).
contract AssetApprovalDAO is AccessControl {
    using EnumerableSet for EnumerableSet.AddressSet;

    uint256 public constant BPS = 10_000;

    enum Action {
        ApproveAsset,
        RejectAsset,
        SuspendAsset,
        ReinstateAsset,
        RetireAsset,
        RevalueAsset,
        AddMember,
        RemoveMember
    }

    enum ProposalState {
        None,
        Active,
        Succeeded,
        Defeated,
        Executed,
        Cancelled
    }

    enum VoteType {
        Against,
        For,
        Abstain
    }

    struct Proposal {
        Action action;
        uint256 assetId;
        uint256 newValuation; // RevalueAsset only
        bytes32 evidenceHash; // hash of the verification / valuation report
        address account; // AddMember / RemoveMember only
        address proposer;
        uint64 createdAt;
        uint64 deadline;
        uint32 forVotes;
        uint32 againstVotes;
        uint32 abstainVotes;
        uint32 eligibleVoters;
        bool executed;
        bool cancelled;
    }

    IAssetRegistry public immutable registry;

    uint64 public votingPeriod;
    uint32 public quorum;
    uint16 public approvalThresholdBps;

    uint256 public proposalCount;
    mapping(uint256 id => Proposal) private _proposals;
    mapping(uint256 id => mapping(address voter => bool)) public hasVoted;
    mapping(uint256 assetId => uint256 proposalId) public openProposalForAsset;

    EnumerableSet.AddressSet private _members;
    mapping(address member => uint64) public memberSince;

    event ProposalCreated(
        uint256 indexed id,
        Action indexed action,
        uint256 indexed assetId,
        address account,
        uint256 newValuation,
        bytes32 evidenceHash,
        address proposer,
        uint64 deadline,
        string description
    );
    event VoteCast(uint256 indexed id, address indexed voter, VoteType support, string comment);
    event ProposalExecuted(uint256 indexed id);
    event ProposalCancelled(uint256 indexed id);
    event MemberAdded(address indexed account);
    event MemberRemoved(address indexed account);
    event SettingsUpdated(uint64 votingPeriod, uint32 quorum, uint16 approvalThresholdBps);

    error ZeroAddress();
    error NotMember(address account);
    error AlreadyMember(address account);
    error InvalidSettings();
    error InvalidAction(Action action);
    error InvalidAssetState(uint256 assetId, IAssetRegistry.AssetStatus status);
    error AssetHasOpenProposal(uint256 assetId, uint256 proposalId);
    error InvalidProposalState(uint256 id, ProposalState state);
    error NotEligible(uint256 id, address voter);
    error AlreadyVoted(uint256 id, address voter);
    error NotAuthorized();
    error QuorumUnreachable(uint256 membersAfter, uint256 quorum);

    modifier onlyMember() {
        if (!_members.contains(msg.sender)) revert NotMember(msg.sender);
        _;
    }

    constructor(
        IAssetRegistry registry_,
        address admin,
        address[] memory initialMembers,
        uint64 votingPeriod_,
        uint32 quorum_,
        uint16 approvalThresholdBps_
    ) {
        if (address(registry_) == address(0) || admin == address(0)) revert ZeroAddress();
        registry = registry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        for (uint256 i; i < initialMembers.length; ++i) {
            _addMember(initialMembers[i]);
        }
        _setSettings(votingPeriod_, quorum_, approvalThresholdBps_);
    }

    // ---------------------------------------------------------------------
    // Proposals
    // ---------------------------------------------------------------------

    /// @notice Proposes Approve / Reject / Suspend / Reinstate / Retire for an asset.
    function proposeAssetAction(Action action, uint256 assetId, bytes32 evidenceHash, string calldata description)
        external
        onlyMember
        returns (uint256)
    {
        if (action > Action.RetireAsset) revert InvalidAction(action);
        _checkAssetAction(action, assetId);
        return _propose(action, assetId, 0, evidenceHash, address(0), description);
    }

    /// @notice Proposes a new valuation for an Approved or Suspended asset.
    function proposeRevaluation(uint256 assetId, uint256 newValuation, bytes32 reportHash, string calldata description)
        external
        onlyMember
        returns (uint256)
    {
        if (newValuation == 0) revert InvalidAction(Action.RevalueAsset);
        _checkAssetAction(Action.RevalueAsset, assetId);
        return _propose(Action.RevalueAsset, assetId, newValuation, reportHash, address(0), description);
    }

    /// @notice Proposes adding or removing a DAO member.
    function proposeMembership(Action action, address account, string calldata description)
        external
        onlyMember
        returns (uint256)
    {
        if (account == address(0)) revert ZeroAddress();
        if (action == Action.AddMember) {
            if (_members.contains(account)) revert AlreadyMember(account);
        } else if (action == Action.RemoveMember) {
            if (!_members.contains(account)) revert NotMember(account);
            if (_members.length() - 1 < quorum) revert QuorumUnreachable(_members.length() - 1, quorum);
        } else {
            revert InvalidAction(action);
        }
        return _propose(action, 0, 0, bytes32(0), account, description);
    }

    function castVote(uint256 id, VoteType support, string calldata comment) external onlyMember {
        Proposal storage p = _proposals[id];
        ProposalState s = state(id);
        if (s != ProposalState.Active && s != ProposalState.Succeeded) revert InvalidProposalState(id, s);
        if (block.timestamp >= p.deadline) revert InvalidProposalState(id, s);
        if (memberSince[msg.sender] > p.createdAt) revert NotEligible(id, msg.sender);
        if (hasVoted[id][msg.sender]) revert AlreadyVoted(id, msg.sender);

        hasVoted[id][msg.sender] = true;
        if (support == VoteType.For) p.forVotes++;
        else if (support == VoteType.Against) p.againstVotes++;
        else p.abstainVotes++;

        emit VoteCast(id, msg.sender, support, comment);
    }

    /// @notice Executes a Succeeded proposal. Anyone can call it.
    function execute(uint256 id) external {
        ProposalState s = state(id);
        if (s != ProposalState.Succeeded) revert InvalidProposalState(id, s);

        Proposal storage p = _proposals[id];
        p.executed = true;
        if (p.action <= Action.RevalueAsset) delete openProposalForAsset[p.assetId];

        if (p.action == Action.ApproveAsset) {
            registry.setStatus(p.assetId, IAssetRegistry.AssetStatus.Approved, _reason(id));
        } else if (p.action == Action.RejectAsset) {
            registry.setStatus(p.assetId, IAssetRegistry.AssetStatus.Rejected, _reason(id));
        } else if (p.action == Action.SuspendAsset) {
            registry.setStatus(p.assetId, IAssetRegistry.AssetStatus.Suspended, _reason(id));
        } else if (p.action == Action.ReinstateAsset) {
            registry.setStatus(p.assetId, IAssetRegistry.AssetStatus.Approved, _reason(id));
        } else if (p.action == Action.RetireAsset) {
            registry.setStatus(p.assetId, IAssetRegistry.AssetStatus.Retired, _reason(id));
        } else if (p.action == Action.RevalueAsset) {
            registry.revalue(p.assetId, p.newValuation, p.evidenceHash);
        } else if (p.action == Action.AddMember) {
            _addMember(p.account);
        } else {
            _removeMember(p.account);
        }

        emit ProposalExecuted(id);
    }

    /// @notice Cancels an Active or Succeeded proposal. Proposer or admin only.
    function cancel(uint256 id) external {
        Proposal storage p = _proposals[id];
        if (msg.sender != p.proposer && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorized();
        ProposalState s = state(id);
        if (s != ProposalState.Active && s != ProposalState.Succeeded) revert InvalidProposalState(id, s);

        p.cancelled = true;
        if (p.action <= Action.RevalueAsset && openProposalForAsset[p.assetId] == id) {
            delete openProposalForAsset[p.assetId];
        }
        emit ProposalCancelled(id);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function state(uint256 id) public view returns (ProposalState) {
        Proposal storage p = _proposals[id];
        if (p.createdAt == 0) return ProposalState.None;
        if (p.cancelled) return ProposalState.Cancelled;
        if (p.executed) return ProposalState.Executed;
        if (_decidedEarly(p)) return ProposalState.Succeeded;
        if (block.timestamp < p.deadline) return ProposalState.Active;
        return _passed(p) ? ProposalState.Succeeded : ProposalState.Defeated;
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    function isMember(address account) external view returns (bool) {
        return _members.contains(account);
    }

    function members() external view returns (address[] memory) {
        return _members.values();
    }

    function memberCount() external view returns (uint256) {
        return _members.length();
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setSettings(uint64 votingPeriod_, uint32 quorum_, uint16 approvalThresholdBps_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setSettings(votingPeriod_, quorum_, approvalThresholdBps_);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _propose(
        Action action,
        uint256 assetId,
        uint256 newValuation,
        bytes32 evidenceHash,
        address account,
        string calldata description
    ) private returns (uint256 id) {
        id = ++proposalCount;
        uint64 deadline = uint64(block.timestamp) + votingPeriod;
        _proposals[id] = Proposal({
            action: action,
            assetId: assetId,
            newValuation: newValuation,
            evidenceHash: evidenceHash,
            account: account,
            proposer: msg.sender,
            createdAt: uint64(block.timestamp),
            deadline: deadline,
            forVotes: 0,
            againstVotes: 0,
            abstainVotes: 0,
            eligibleVoters: uint32(_members.length()),
            executed: false,
            cancelled: false
        });
        if (action <= Action.RevalueAsset) openProposalForAsset[assetId] = id;

        emit ProposalCreated(
            id, action, assetId, account, newValuation, evidenceHash, msg.sender, deadline, description
        );
    }

    function _checkAssetAction(Action action, uint256 assetId) private view {
        uint256 open = openProposalForAsset[assetId];
        if (open != 0) {
            ProposalState s = state(open);
            if (s == ProposalState.Active || s == ProposalState.Succeeded) revert AssetHasOpenProposal(assetId, open);
        }

        IAssetRegistry.AssetStatus st = registry.assetStatus(assetId);
        bool ok;
        if (action == Action.ApproveAsset || action == Action.RejectAsset) {
            ok = st == IAssetRegistry.AssetStatus.Pending;
        } else if (action == Action.SuspendAsset) {
            ok = st == IAssetRegistry.AssetStatus.Approved;
        } else if (action == Action.ReinstateAsset) {
            ok = st == IAssetRegistry.AssetStatus.Suspended;
        } else {
            // RetireAsset, RevalueAsset
            ok = st == IAssetRegistry.AssetStatus.Approved || st == IAssetRegistry.AssetStatus.Suspended;
        }
        if (!ok) revert InvalidAssetState(assetId, st);
    }

    function _passed(Proposal storage p) private view returns (bool) {
        uint256 cast = uint256(p.forVotes) + p.againstVotes + p.abstainVotes;
        if (cast < quorum || p.forVotes == 0) return false;
        return uint256(p.forVotes) * BPS >= uint256(approvalThresholdBps) * (uint256(p.forVotes) + p.againstVotes);
    }

    /// @dev For votes alone meet the threshold against every eligible member: no remaining votes can flip it.
    function _decidedEarly(Proposal storage p) private view returns (bool) {
        if (p.forVotes < quorum) return false;
        return uint256(p.forVotes) * BPS >= uint256(approvalThresholdBps) * p.eligibleVoters;
    }

    function _setSettings(uint64 votingPeriod_, uint32 quorum_, uint16 approvalThresholdBps_) private {
        if (
            votingPeriod_ == 0 || quorum_ == 0 || quorum_ > _members.length() || approvalThresholdBps_ <= BPS / 2
                || approvalThresholdBps_ > BPS
        ) revert InvalidSettings();
        votingPeriod = votingPeriod_;
        quorum = quorum_;
        approvalThresholdBps = approvalThresholdBps_;
        emit SettingsUpdated(votingPeriod_, quorum_, approvalThresholdBps_);
    }

    function _addMember(address account) private {
        if (account == address(0)) revert ZeroAddress();
        if (!_members.add(account)) revert AlreadyMember(account);
        memberSince[account] = uint64(block.timestamp);
        emit MemberAdded(account);
    }

    function _removeMember(address account) private {
        if (_members.length() - 1 < quorum) revert QuorumUnreachable(_members.length() - 1, quorum);
        if (!_members.remove(account)) revert NotMember(account);
        delete memberSince[account];
        emit MemberRemoved(account);
    }

    function _reason(uint256 id) private pure returns (string memory) {
        return string.concat("DAO proposal #", Strings.toString(id));
    }
}
