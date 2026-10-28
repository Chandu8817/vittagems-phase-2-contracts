// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Phase1BaseTest} from "../Phase1BaseTest.sol";
import {AssetApprovalDAO} from "../../src/governance/AssetApprovalDAO.sol";
import {IAssetRegistry} from "../../src/interfaces/IAssetRegistry.sol";

contract AssetApprovalDAOTest is Phase1BaseTest {
    function _propose(AssetApprovalDAO.Action action, uint256 assetId) internal returns (uint256 pid) {
        vm.prank(m1);
        pid = dao.proposeAssetAction(action, assetId, keccak256("report"), "verify gem lot");
    }

    function _vote(address who, uint256 pid, AssetApprovalDAO.VoteType v) internal {
        vm.prank(who);
        dao.castVote(pid, v, "");
    }

    function test_ApproveAssetWithEarlyMajority() public {
        uint256 id = _register(100e18);
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Active));

        _vote(m1, pid, AssetApprovalDAO.VoteType.For);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Active));
        _vote(m2, pid, AssetApprovalDAO.VoteType.For); // 2/3 >= 60%: decided
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Succeeded));

        dao.execute(pid);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Executed));
        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Approved));
        assertEq(registry.totalApprovedValue(), 100e18);
    }

    function test_PassesAfterDeadlineOnVotesCast() public {
        uint256 id = _register(100e18);
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);
        _vote(m1, pid, AssetApprovalDAO.VoteType.For);
        _vote(m2, pid, AssetApprovalDAO.VoteType.Abstain);

        vm.warp(block.timestamp + VOTING_PERIOD);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Succeeded));
        dao.execute(pid);
        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Approved));
    }

    function test_DefeatedWithoutQuorum() public {
        uint256 id = _register(100e18);
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);
        _vote(m1, pid, AssetApprovalDAO.VoteType.For);

        vm.warp(block.timestamp + VOTING_PERIOD);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Defeated));
        vm.expectRevert(
            abi.encodeWithSelector(
                AssetApprovalDAO.InvalidProposalState.selector, pid, AssetApprovalDAO.ProposalState.Defeated
            )
        );
        dao.execute(pid);
    }

    function test_DefeatedByAgainstVotes() public {
        uint256 id = _register(100e18);
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);
        _vote(m1, pid, AssetApprovalDAO.VoteType.For);
        _vote(m2, pid, AssetApprovalDAO.VoteType.Against);
        _vote(m3, pid, AssetApprovalDAO.VoteType.Against);

        vm.warp(block.timestamp + VOTING_PERIOD);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Defeated));

        // A defeated proposal frees the asset for a new one.
        _propose(AssetApprovalDAO.Action.RejectAsset, id);
    }

    function test_RevertWhen_SecondOpenProposalForAsset() public {
        uint256 id = _register(100e18);
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);
        vm.expectRevert(abi.encodeWithSelector(AssetApprovalDAO.AssetHasOpenProposal.selector, id, pid));
        _propose(AssetApprovalDAO.Action.RejectAsset, id);
    }

    function test_RevertWhen_ActionDoesNotFitAssetState() public {
        uint256 id = _register(100e18);
        vm.expectRevert(
            abi.encodeWithSelector(AssetApprovalDAO.InvalidAssetState.selector, id, IAssetRegistry.AssetStatus.Pending)
        );
        _propose(AssetApprovalDAO.Action.SuspendAsset, id);
    }

    function test_RevertWhen_NonMemberProposesOrVotes() public {
        uint256 id = _register(100e18);
        vm.expectRevert(abi.encodeWithSelector(AssetApprovalDAO.NotMember.selector, outsider));
        vm.prank(outsider);
        dao.proposeAssetAction(AssetApprovalDAO.Action.ApproveAsset, id, bytes32(0), "");

        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);
        vm.expectRevert(abi.encodeWithSelector(AssetApprovalDAO.NotMember.selector, outsider));
        vm.prank(outsider);
        dao.castVote(pid, AssetApprovalDAO.VoteType.For, "");
    }

    function test_RevertWhen_DoubleVote() public {
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, _register(100e18));
        _vote(m1, pid, AssetApprovalDAO.VoteType.For);
        vm.expectRevert(abi.encodeWithSelector(AssetApprovalDAO.AlreadyVoted.selector, pid, m1));
        _vote(m1, pid, AssetApprovalDAO.VoteType.For);
    }

    function test_RevertWhen_VoteAfterDeadline() public {
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, _register(100e18));
        vm.warp(block.timestamp + VOTING_PERIOD);
        vm.expectRevert();
        _vote(m1, pid, AssetApprovalDAO.VoteType.For);
    }

    function test_SuspendReinstateRetireFlow() public {
        uint256 id = _registerApproved(100e18);

        _daoAction(AssetApprovalDAO.Action.SuspendAsset, id);
        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Suspended));

        _daoAction(AssetApprovalDAO.Action.ReinstateAsset, id);
        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Approved));

        _daoAction(AssetApprovalDAO.Action.RetireAsset, id);
        assertEq(uint8(registry.assetStatus(id)), uint8(IAssetRegistry.AssetStatus.Retired));
    }

    function test_RevaluationThroughDao() public {
        uint256 id = _registerApproved(100e18);

        vm.prank(m2);
        uint256 pid = dao.proposeRevaluation(id, 130e18, keccak256("appraisal-2026"), "annual revaluation");
        _passProposal(pid);

        assertEq(registry.assetValuation(id), 130e18);
        assertEq(registry.totalApprovedValue(), 130e18);
    }

    function test_AddMemberThenNewMemberVotesOnLaterProposals() public {
        address m4 = makeAddr("member4");
        uint256 id = _register(100e18);
        uint256 earlier = _propose(AssetApprovalDAO.Action.ApproveAsset, id);

        vm.warp(block.timestamp + 1);
        vm.prank(m1);
        uint256 pid = dao.proposeMembership(AssetApprovalDAO.Action.AddMember, m4, "add auditor");
        _passProposal(pid);
        assertTrue(dao.isMember(m4));
        assertEq(dao.memberCount(), 4);

        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(AssetApprovalDAO.NotEligible.selector, earlier, m4));
        _vote(m4, earlier, AssetApprovalDAO.VoteType.For);

        uint256 later = _propose(AssetApprovalDAO.Action.ApproveAsset, _register(1e18));
        _vote(m4, later, AssetApprovalDAO.VoteType.For);
    }

    function test_RemoveMember() public {
        vm.prank(m1);
        uint256 pid = dao.proposeMembership(AssetApprovalDAO.Action.RemoveMember, m3, "rotation");
        _passProposal(pid);
        assertFalse(dao.isMember(m3));
        assertEq(dao.memberCount(), 2);
    }

    function test_RevertWhen_RemovalBreaksQuorum() public {
        vm.prank(m1);
        uint256 pid = dao.proposeMembership(AssetApprovalDAO.Action.RemoveMember, m3, "");
        _passProposal(pid);

        vm.expectRevert(abi.encodeWithSelector(AssetApprovalDAO.QuorumUnreachable.selector, 1, QUORUM));
        vm.prank(m1);
        dao.proposeMembership(AssetApprovalDAO.Action.RemoveMember, m2, "");
    }

    function test_CancelFreesAsset() public {
        uint256 id = _register(100e18);
        uint256 pid = _propose(AssetApprovalDAO.Action.ApproveAsset, id);

        vm.expectRevert(AssetApprovalDAO.NotAuthorized.selector);
        vm.prank(m2);
        dao.cancel(pid);

        vm.prank(m1);
        dao.cancel(pid);
        assertEq(uint8(dao.state(pid)), uint8(AssetApprovalDAO.ProposalState.Cancelled));
        assertEq(dao.openProposalForAsset(id), 0);
        _propose(AssetApprovalDAO.Action.ApproveAsset, id);
    }

    function test_RevertWhen_InvalidSettings() public {
        vm.startPrank(admin);
        vm.expectRevert(AssetApprovalDAO.InvalidSettings.selector);
        dao.setSettings(1 days, 4, 6000); // quorum > members
        vm.expectRevert(AssetApprovalDAO.InvalidSettings.selector);
        dao.setSettings(1 days, 2, 5000); // simple tie would pass
        vm.stopPrank();
    }
}
