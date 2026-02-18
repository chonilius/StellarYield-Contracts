// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IVaultFactory} from "../interfaces/IVaultFactory.sol";
import {SingleRWA_Vault} from "./SingleRWA_Vault.sol";
import {ISingleRWA_Vault} from "../interfaces/ISingleRWA_Vault.sol";

/**
 * @title VaultFactory
 * @notice Factory contract for creating and managing SingleRWA vaults
 * @dev Creates individual vaults for each RWA investment
 *
 *      Architecture:
 *      VaultFactory
 *          ├── SingleRWA_Vault (Treasury Bill A)
 *          ├── SingleRWA_Vault (Corporate Bond B)
 *          ├── SingleRWA_Vault (Real Estate Fund C)
 *          └── ... more vaults
 */
contract VaultFactory is IVaultFactory {
    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Admin with full control
    address public admin;

    /// @notice Operators who can create vaults
    mapping(address => bool) public operators;

    /// @notice All registered vaults
    address[] private _allVaults;

    /// @notice Single RWA vaults only
    address[] private _singleRWAVaults;

    /// @notice Vault info mapping
    mapping(address => VaultInfo) private _vaultInfo;

    /// @notice Aggregator vault address (placeholder for future)
    address public override aggregatorVault;

    /// @notice Global zkMe settings (inherited by new vaults)
    address public defaultZkmeVerifier;
    address public defaultCooperator;

    /// @notice Default deposit token (e.g., USDC on Stellar)
    address public defaultAsset;

    // ============================================
    // EVENTS
    // ============================================

    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);
    event OperatorUpdated(address indexed operator, bool status);
    event DefaultsUpdated(
        address asset,
        address zkmeVerifier,
        address cooperator
    );

    // ============================================
    // MODIFIERS
    // ============================================

    modifier onlyAdmin() {
        _onlyAdmin();
        _;
    }

    modifier onlyOperatorOrAdmin() {
        _onlyOperatorOrAdmin();
        _;
    }

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @notice Creates the VaultFactory
     * @param admin_ Admin address
     * @param defaultAsset_ Default deposit token (e.g., USDC)
     * @param zkmeVerifier_ Default zkMe verifier contract
     * @param cooperator_ Default zkMe cooperator address
     */
    constructor(
        address admin_,
        address defaultAsset_,
        address zkmeVerifier_,
        address cooperator_
    ) {
        require(admin_ != address(0), "Zero admin");

        admin = admin_;
        defaultAsset = defaultAsset_;
        defaultZkmeVerifier = zkmeVerifier_;
        defaultCooperator = cooperator_;
        operators[admin_] = true;
    }

    // ============================================
    // MODIFIER FUNCTIONS
    // ============================================

    function _onlyAdmin() internal {
        if (msg.sender != admin) revert NotAuthorized();
    }

    function _onlyOperatorOrAdmin() internal {
        if (!operators[msg.sender] && msg.sender != admin)
            revert NotAuthorized();
    }

    // ============================================
    // VAULT CREATION
    // ============================================

    /// @inheritdoc IVaultFactory
    function createSingleRWAVault(
        address asset,
        string calldata name,
        string calldata symbol,
        string calldata rwaName,
        string calldata rwaSymbol,
        string calldata rwaDocumentURI,
        uint256 maturityDate
    ) external override onlyOperatorOrAdmin returns (address vault) {
        return
            _createSingleRWAVault(
                asset,
                name,
                symbol,
                ISingleRWA_Vault.RWADetails({
                    name: rwaName,
                    symbol: rwaSymbol,
                    documentURI: rwaDocumentURI,
                    category: "",
                    expectedAPY: 0
                }),
                maturityDate,
                0, // fundingTarget
                0, // minDeposit
                0, // maxDepositPerUser
                200 // earlyRedemptionFeeBps (2%)
            );
    }

    /**
     * @notice Create a single RWA vault with full parameters
     * @param asset Deposit token address
     * @param name Vault share token name
     * @param symbol Vault share token symbol
     * @param rwaDetails RWA information struct
     * @param maturityDate Maturity timestamp
     * @param fundingTarget Minimum funding amount
     * @param minDeposit Minimum deposit per transaction
     * @param maxDepositPerUser Maximum deposit per user
     * @param earlyRedemptionFeeBps Early exit fee in basis points
     */
    function createSingleRWAVaultFull(
        address asset,
        string calldata name,
        string calldata symbol,
        ISingleRWA_Vault.RWADetails calldata rwaDetails,
        uint256 maturityDate,
        uint256 fundingTarget,
        uint256 minDeposit,
        uint256 maxDepositPerUser,
        uint256 earlyRedemptionFeeBps
    ) external onlyOperatorOrAdmin returns (address vault) {
        return
            _createSingleRWAVault(
                asset,
                name,
                symbol,
                rwaDetails,
                maturityDate,
                fundingTarget,
                minDeposit,
                maxDepositPerUser,
                earlyRedemptionFeeBps
            );
    }

    /**
     * @dev Internal function to create a SingleRWA vault
     */
    function _createSingleRWAVault(
        address asset,
        string memory name,
        string memory symbol,
        ISingleRWA_Vault.RWADetails memory rwaDetails,
        uint256 maturityDate,
        uint256 fundingTarget,
        uint256 minDeposit,
        uint256 maxDepositPerUser,
        uint256 earlyRedemptionFeeBps
    ) internal returns (address vault) {
        // Use default asset if not specified
        address vaultAsset = asset == address(0) ? defaultAsset : asset;
        require(vaultAsset != address(0), "No asset specified");

        // Create init params
        ISingleRWA_Vault.InitParams memory params = ISingleRWA_Vault
            .InitParams({
                asset: vaultAsset,
                name: name,
                symbol: symbol,
                admin: admin,
                zkmeVerifier: defaultZkmeVerifier,
                cooperator: defaultCooperator,
                fundingTarget: fundingTarget,
                maturityDate: maturityDate,
                minDeposit: minDeposit,
                maxDepositPerUser: maxDepositPerUser,
                earlyRedemptionFeeBps: earlyRedemptionFeeBps,
                rwaDetails: rwaDetails
            });

        // Deploy new vault
        SingleRWA_Vault newVault = new SingleRWA_Vault(params);
        vault = address(newVault);

        // Register vault
        _vaultInfo[vault] = VaultInfo({
            vault: vault,
            vaultType: VaultType.SingleRWA,
            name: name,
            symbol: symbol,
            active: true,
            createdAt: block.timestamp
        });

        _allVaults.push(vault);
        _singleRWAVaults.push(vault);

        emit VaultCreated(vault, VaultType.SingleRWA, name, msg.sender);

        return vault;
    }

    /// @inheritdoc IVaultFactory
    function createAggregatorVault(
        address /*asset*/,
        string calldata /*name*/,
        string calldata /*symbol*/
    ) external pure override returns (address) {
        // Not implemented in single-RWA approach
        revert("Aggregator vault not supported");
    }

    // ============================================
    // VAULT MANAGEMENT
    // ============================================

    /// @inheritdoc IVaultFactory
    function setVaultStatus(
        address vault,
        bool active
    ) external override onlyAdmin {
        if (_vaultInfo[vault].vault == address(0)) revert VaultNotFound();

        _vaultInfo[vault].active = active;
        emit VaultStatusChanged(vault, active);
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /// @inheritdoc IVaultFactory
    function getAllVaults() external view override returns (address[] memory) {
        return _allVaults;
    }

    /// @inheritdoc IVaultFactory
    function getSingleRWAVaults()
        external
        view
        override
        returns (address[] memory)
    {
        return _singleRWAVaults;
    }

    /// @inheritdoc IVaultFactory
    function getVaultInfo(
        address vault
    ) external view override returns (VaultInfo memory) {
        return _vaultInfo[vault];
    }

    /// @inheritdoc IVaultFactory
    function isRegisteredVault(
        address vault
    ) external view override returns (bool) {
        return _vaultInfo[vault].vault != address(0);
    }

    /**
     * @notice Get count of all vaults
     */
    function getVaultCount() external view returns (uint256) {
        return _allVaults.length;
    }

    /**
     * @notice Get active vaults only
     */
    function getActiveVaults() external view returns (address[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < _allVaults.length; i++) {
            if (_vaultInfo[_allVaults[i]].active) {
                activeCount++;
            }
        }

        address[] memory activeVaults = new address[](activeCount);
        uint256 index = 0;
        for (uint256 i = 0; i < _allVaults.length; i++) {
            if (_vaultInfo[_allVaults[i]].active) {
                activeVaults[index] = _allVaults[i];
                index++;
            }
        }

        return activeVaults;
    }

    /**
     * @notice Get vaults by category
     * @param category The RWA category to filter by
     */
    function getVaultsByCategory(
        string calldata category
    ) external view returns (address[] memory) {
        uint256 matchCount = 0;

        // First pass: count matches
        for (uint256 i = 0; i < _singleRWAVaults.length; i++) {
            ISingleRWA_Vault vault = ISingleRWA_Vault(_singleRWAVaults[i]);
            if (
                keccak256(bytes(vault.rwaCategory())) ==
                keccak256(bytes(category))
            ) {
                matchCount++;
            }
        }

        // Second pass: populate array
        address[] memory matchedVaults = new address[](matchCount);
        uint256 index = 0;
        for (uint256 i = 0; i < _singleRWAVaults.length; i++) {
            ISingleRWA_Vault vault = ISingleRWA_Vault(_singleRWAVaults[i]);
            if (
                keccak256(bytes(vault.rwaCategory())) ==
                keccak256(bytes(category))
            ) {
                matchedVaults[index] = _singleRWAVaults[i];
                index++;
            }
        }

        return matchedVaults;
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /**
     * @notice Transfer admin role
     * @param newAdmin New admin address
     */
    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Zero address");
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminTransferred(oldAdmin, newAdmin);
    }

    /**
     * @notice Set operator status
     * @param operator Address to update
     * @param status New status
     */
    function setOperator(address operator, bool status) external onlyAdmin {
        require(operator != address(0), "Zero address");
        operators[operator] = status;
        emit OperatorUpdated(operator, status);
    }

    /**
     * @notice Update default settings for new vaults
     * @param asset_ Default deposit token
     * @param zkmeVerifier_ Default zkMe verifier
     * @param cooperator_ Default cooperator
     */
    function setDefaults(
        address asset_,
        address zkmeVerifier_,
        address cooperator_
    ) external onlyAdmin {
        defaultAsset = asset_;
        defaultZkmeVerifier = zkmeVerifier_;
        defaultCooperator = cooperator_;
        emit DefaultsUpdated(asset_, zkmeVerifier_, cooperator_);
    }

    /**
     * @notice Batch create multiple vaults
     * @param params Array of vault creation parameters
     * @return vaults Array of created vault addresses
     */
    function batchCreateVaults(
        BatchVaultParams[] calldata params
    ) external onlyOperatorOrAdmin returns (address[] memory vaults) {
        vaults = new address[](params.length);

        for (uint256 i = 0; i < params.length; i++) {
            vaults[i] = _createSingleRWAVault(
                params[i].asset,
                params[i].name,
                params[i].symbol,
                params[i].rwaDetails,
                params[i].maturityDate,
                params[i].fundingTarget,
                params[i].minDeposit,
                params[i].maxDepositPerUser,
                params[i].earlyRedemptionFeeBps
            );
        }

        return vaults;
    }

    /**
     * @notice Parameters for batch vault creation
     */
    struct BatchVaultParams {
        address asset;
        string name;
        string symbol;
        ISingleRWA_Vault.RWADetails rwaDetails;
        uint256 maturityDate;
        uint256 fundingTarget;
        uint256 minDeposit;
        uint256 maxDepositPerUser;
        uint256 earlyRedemptionFeeBps;
    }
}
