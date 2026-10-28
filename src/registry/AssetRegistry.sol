// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {IAssetRegistry} from "../interfaces/IAssetRegistry.sol";
import {IReserveHook} from "../interfaces/IReserveHook.sol";

/// @title AssetRegistry
/// @notice Company Asset Registry. Each real-world asset (gem lot, mining output, ...) is an ERC-721 token
///         carrying its metadata URI, document hash, valuation and DAO verification status.
/// @dev - Registrars register and edit assets while they are Pending or Rejected.
///      - Only the AssetApprovalDAO (DAO_ROLE) can approve, reject, suspend, reinstate, retire or revalue.
///      - Approved and Suspended assets back the reserves, so their NFTs cannot be transferred.
///      - Every status or valuation change notifies the ReserveManager hook to keep reserve totals in sync.
contract AssetRegistry is ERC721URIStorage, AccessControl, Pausable, IAssetRegistry {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant DAO_ROLE = keccak256("DAO_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    uint256 public nextAssetId = 1;
    uint256 public totalApprovedValue;
    IReserveHook public reserveHook;

    mapping(uint256 assetId => Asset) private _assets;
    mapping(bytes32 externalRef => uint256 assetId) public assetIdByRef;
    mapping(AssetStatus status => uint256 count) private _statusCount;

    event AssetRegistered(
        uint256 indexed assetId,
        address indexed owner,
        bytes32 indexed assetClass,
        bytes32 externalRef,
        bytes32 documentHash,
        uint256 valuation,
        string uri
    );
    event AssetUpdated(uint256 indexed assetId, bytes32 documentHash, uint256 valuation, string uri);
    event AssetStatusChanged(uint256 indexed assetId, AssetStatus indexed from, AssetStatus indexed to, string reason);
    event AssetRevalued(uint256 indexed assetId, uint256 oldValuation, uint256 newValuation, bytes32 reportHash);
    event ReserveHookUpdated(address indexed hook);

    error ZeroAddress();
    error ZeroValue();
    error DuplicateExternalRef(bytes32 externalRef, uint256 existingAssetId);
    error AssetNotFound(uint256 assetId);
    error InvalidTransition(uint256 assetId, AssetStatus from, AssetStatus to);
    error NotEditable(uint256 assetId, AssetStatus status);
    error AssetLocked(uint256 assetId, AssetStatus status);

    constructor(string memory name_, string memory symbol_, address admin) ERC721(name_, symbol_) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Registration (registrar)
    // ---------------------------------------------------------------------

    /// @notice Registers a new asset as an NFT owned by `owner`, pending DAO approval.
    /// @param externalRef Unique off-chain reference (certificate number, asset code); prevents double registration.
    /// @param documentHash Hash of the uploaded document bundle (e.g. SHA-256 of the archive).
    /// @param valuation Appraised value in USD, 18 decimals.
    /// @param uri Metadata URI (e.g. ipfs://...).
    function registerAsset(
        address owner,
        bytes32 assetClass,
        bytes32 externalRef,
        bytes32 documentHash,
        uint256 valuation,
        string calldata uri
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused returns (uint256 assetId) {
        if (owner == address(0)) revert ZeroAddress();
        if (assetClass == bytes32(0) || externalRef == bytes32(0) || documentHash == bytes32(0) || valuation == 0) {
            revert ZeroValue();
        }
        uint256 existing = assetIdByRef[externalRef];
        if (existing != 0) revert DuplicateExternalRef(externalRef, existing);

        assetId = nextAssetId++;
        assetIdByRef[externalRef] = assetId;
        _assets[assetId] = Asset({
            assetClass: assetClass,
            externalRef: externalRef,
            documentHash: documentHash,
            valuation: valuation,
            valuedAt: uint64(block.timestamp),
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            status: AssetStatus.Pending,
            registrant: msg.sender
        });
        _statusCount[AssetStatus.Pending]++;

        _mint(owner, assetId);
        _setTokenURI(assetId, uri);

        emit AssetRegistered(assetId, owner, assetClass, externalRef, documentHash, valuation, uri);
        emit AssetStatusChanged(assetId, AssetStatus.None, AssetStatus.Pending, "registered");
    }

    /// @notice Edits a Pending or Rejected asset. A Rejected asset is resubmitted (back to Pending).
    /// @param uri New metadata URI; empty keeps the current one.
    function updateAsset(uint256 assetId, bytes32 documentHash, uint256 valuation, string calldata uri)
        external
        onlyRole(REGISTRAR_ROLE)
        whenNotPaused
    {
        Asset storage a = _get(assetId);
        if (a.status != AssetStatus.Pending && a.status != AssetStatus.Rejected) revert NotEditable(assetId, a.status);
        if (documentHash == bytes32(0) || valuation == 0) revert ZeroValue();

        a.documentHash = documentHash;
        a.valuation = valuation;
        a.valuedAt = uint64(block.timestamp);
        a.updatedAt = uint64(block.timestamp);
        if (bytes(uri).length != 0) _setTokenURI(assetId, uri);

        emit AssetUpdated(assetId, documentHash, valuation, uri);

        if (a.status == AssetStatus.Rejected) _transition(assetId, a, AssetStatus.Pending, "resubmitted");
    }

    // ---------------------------------------------------------------------
    // DAO actions
    // ---------------------------------------------------------------------

    /// @inheritdoc IAssetRegistry
    function setStatus(uint256 assetId, AssetStatus newStatus, string calldata reason)
        external
        onlyRole(DAO_ROLE)
        whenNotPaused
    {
        Asset storage a = _get(assetId);
        if (!_daoTransitionAllowed(a.status, newStatus)) revert InvalidTransition(assetId, a.status, newStatus);
        _transition(assetId, a, newStatus, reason);
    }

    /// @inheritdoc IAssetRegistry
    function revalue(uint256 assetId, uint256 newValuation, bytes32 reportHash)
        external
        onlyRole(DAO_ROLE)
        whenNotPaused
    {
        Asset storage a = _get(assetId);
        if (a.status != AssetStatus.Approved && a.status != AssetStatus.Suspended) {
            revert NotEditable(assetId, a.status);
        }
        if (newValuation == 0) revert ZeroValue();

        uint256 old = a.valuation;
        if (a.status == AssetStatus.Approved) totalApprovedValue = totalApprovedValue - old + newValuation;
        a.valuation = newValuation;
        a.valuedAt = uint64(block.timestamp);
        a.updatedAt = uint64(block.timestamp);

        emit AssetRevalued(assetId, old, newValuation, reportHash);
        _notify(assetId);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setReserveHook(IReserveHook hook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        reserveHook = hook;
        emit ReserveHookUpdated(address(hook));
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getAsset(uint256 assetId) external view returns (Asset memory) {
        return _assets[assetId];
    }

    function assetStatus(uint256 assetId) external view returns (AssetStatus) {
        return _assets[assetId].status;
    }

    function assetValuation(uint256 assetId) external view returns (uint256) {
        return _assets[assetId].valuation;
    }

    function statusCount(AssetStatus status) external view returns (uint256) {
        return _statusCount[status];
    }

    function totalAssets() external view returns (uint256) {
        return nextAssetId - 1;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _get(uint256 assetId) private view returns (Asset storage a) {
        a = _assets[assetId];
        if (a.status == AssetStatus.None) revert AssetNotFound(assetId);
    }

    function _daoTransitionAllowed(AssetStatus from, AssetStatus to) private pure returns (bool) {
        if (from == AssetStatus.Pending) return to == AssetStatus.Approved || to == AssetStatus.Rejected;
        if (from == AssetStatus.Approved) return to == AssetStatus.Suspended || to == AssetStatus.Retired;
        if (from == AssetStatus.Suspended) return to == AssetStatus.Approved || to == AssetStatus.Retired;
        return false;
    }

    function _transition(uint256 assetId, Asset storage a, AssetStatus to, string memory reason) private {
        AssetStatus from = a.status;
        if (from == AssetStatus.Approved) totalApprovedValue -= a.valuation;
        if (to == AssetStatus.Approved) totalApprovedValue += a.valuation;
        _statusCount[from]--;
        _statusCount[to]++;

        a.status = to;
        a.updatedAt = uint64(block.timestamp);

        emit AssetStatusChanged(assetId, from, to, reason);
        _notify(assetId);
    }

    function _notify(uint256 assetId) private {
        if (address(reserveHook) != address(0)) reserveHook.onAssetUpdated(assetId);
    }

    /// @dev Blocks transfers (not mints) of assets that back reserves, and all transfers while paused.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            _requireNotPaused();
            AssetStatus s = _assets[tokenId].status;
            if (s == AssetStatus.Approved || s == AssetStatus.Suspended) revert AssetLocked(tokenId, s);
        }
        return super._update(to, tokenId, auth);
    }
}
