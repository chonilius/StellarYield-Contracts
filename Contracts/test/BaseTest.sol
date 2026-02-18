// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.13;

import {Test, console} from "forge-std/Test.sol";
import {SingleRWA_Vault} from "../src/SingleRWA_Vault.sol";
import {ISingleRWA_Vault} from "../interfaces/ISingleRWA_Vault.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockZKMEVerify} from "./mocks/MockZKMEVerify.sol";

/**
 * @title BaseTest
 * @notice Base test contract with common setup and helper functions
 */
abstract contract BaseTest is Test {
    // ============================================
    // CONTRACTS
    // ============================================
    SingleRWA_Vault public vault;
    VaultFactory public factory;
    MockERC20 public usdc;
    MockZKMEVerify public zkmeVerifier;

    // ============================================
    // ADDRESSES
    // ============================================
    address public admin = makeAddr("admin");
    address public operator = makeAddr("operator");
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");
    address public cooperator = makeAddr("cooperator");
    address public recipient = makeAddr("recipient");

    // ============================================
    // CONSTANTS
    // ============================================
    uint256 public constant INITIAL_BALANCE = 1_000_000e6; // 1M USDC
    uint256 public constant DEPOSIT_AMOUNT = 10_000e6; // 10K USDC
    uint256 public constant MIN_DEPOSIT = 100e6; // 100 USDC
    uint256 public constant MAX_DEPOSIT_PER_USER = 100_000e6; // 100K USDC
    uint256 public constant FUNDING_TARGET = 50_000e6; // 50K USDC
    uint256 public constant EARLY_REDEMPTION_FEE_BPS = 200; // 2%
    uint256 public constant YIELD_AMOUNT = 1_000e6; // 1K USDC yield
    uint256 public constant ONE_DAY = 1 days;
    uint256 public constant ONE_YEAR = 365 days;

    // ============================================
    // SETUP
    // ============================================

    function setUp() public virtual {
        // Deploy mock tokens
        usdc = new MockERC20("USD Coin", "USDC", 6);

        // Deploy mock zkMe verifier
        zkmeVerifier = new MockZKMEVerify();

        // Mint tokens to users
        usdc.mint(admin, INITIAL_BALANCE);
        usdc.mint(operator, INITIAL_BALANCE);
        usdc.mint(user1, INITIAL_BALANCE);
        usdc.mint(user2, INITIAL_BALANCE);
        usdc.mint(user3, INITIAL_BALANCE);

        // Setup KYC approvals for all users
        zkmeVerifier.setApproval(cooperator, admin, true);
        zkmeVerifier.setApproval(cooperator, operator, true);
        zkmeVerifier.setApproval(cooperator, user1, true);
        zkmeVerifier.setApproval(cooperator, user2, true);
        zkmeVerifier.setApproval(cooperator, user3, true);
    }

    // ============================================
    // HELPER FUNCTIONS
    // ============================================

    /**
     * @notice Create default RWA details
     */
    function _createDefaultRWADetails()
        internal
        pure
        returns (ISingleRWA_Vault.RWADetails memory)
    {
        return
            ISingleRWA_Vault.RWADetails({
                name: "US Treasury 6-Month Bill",
                symbol: "USTB6M",
                documentURI: "ipfs://QmTreasuryDocs",
                category: "Treasury",
                expectedAPY: 500 // 5%
            });
    }

    /**
     * @notice Create default init params for vault
     */
    function _createDefaultInitParams()
        internal
        view
        returns (ISingleRWA_Vault.InitParams memory)
    {
        return
            ISingleRWA_Vault.InitParams({
                asset: address(usdc),
                name: "StellarYield T-Bill Vault",
                symbol: "myTBILL",
                admin: admin,
                zkmeVerifier: address(zkmeVerifier),
                cooperator: cooperator,
                fundingTarget: FUNDING_TARGET,
                maturityDate: block.timestamp + ONE_YEAR,
                minDeposit: MIN_DEPOSIT,
                maxDepositPerUser: MAX_DEPOSIT_PER_USER,
                earlyRedemptionFeeBps: EARLY_REDEMPTION_FEE_BPS,
                rwaDetails: _createDefaultRWADetails()
            });
    }

    /**
     * @notice Deploy a vault with default parameters
     */
    function _deployDefaultVault() internal returns (SingleRWA_Vault) {
        ISingleRWA_Vault.InitParams memory params = _createDefaultInitParams();
        return new SingleRWA_Vault(params);
    }

    /**
     * @notice Deploy a vault with custom maturity date
     */
    function _deployVaultWithMaturity(
        uint256 maturityDate
    ) internal returns (SingleRWA_Vault) {
        ISingleRWA_Vault.InitParams memory params = _createDefaultInitParams();
        params.maturityDate = maturityDate;
        return new SingleRWA_Vault(params);
    }

    /**
     * @notice Deploy a vault without zkMe verification (for testing)
     */
    function _deployVaultWithoutKYC() internal returns (SingleRWA_Vault) {
        ISingleRWA_Vault.InitParams memory params = _createDefaultInitParams();
        params.zkmeVerifier = address(0);
        return new SingleRWA_Vault(params);
    }

    /**
     * @notice Deploy vault factory
     */
    function _deployFactory() internal returns (VaultFactory) {
        return
            new VaultFactory(
                admin,
                address(usdc),
                address(zkmeVerifier),
                cooperator
            );
    }

    /**
     * @notice Approve and deposit to vault
     */
    function _approveAndDeposit(
        SingleRWA_Vault _vault,
        address user,
        uint256 amount
    ) internal returns (uint256 shares) {
        vm.startPrank(user);
        usdc.approve(address(_vault), amount);
        shares = _vault.deposit(amount, user);
        vm.stopPrank();
    }

    /**
     * @notice Approve and distribute yield
     */
    function _approveAndDistributeYield(
        SingleRWA_Vault _vault,
        address _operator,
        uint256 amount
    ) internal returns (uint256 epoch) {
        vm.startPrank(_operator);
        usdc.approve(address(_vault), amount);
        epoch = _vault.distributeYield(amount);
        vm.stopPrank();
    }

    /**
     * @notice Move vault to Active state
     */
    function _activateVault(
        SingleRWA_Vault _vault,
        address _operator
    ) internal {
        vm.prank(_operator);
        _vault.activateVault();
    }

    /**
     * @notice Move vault to Matured state
     */
    function _matureVault(SingleRWA_Vault _vault, address _operator) internal {
        uint256 maturity = _vault.maturityDate();
        vm.warp(maturity + 1);
        vm.prank(_operator);
        _vault.matureVault();
    }

    /**
     * @notice Fund vault to meet funding target
     */
    function _fundVaultToTarget(SingleRWA_Vault _vault) internal {
        uint256 target = _vault.fundingTarget();
        _approveAndDeposit(_vault, user1, target);
    }

    /**
     * @notice Setup vault in Active state with deposits
     */
    function _setupActiveVault()
        internal
        returns (SingleRWA_Vault activeVault)
    {
        activeVault = _deployDefaultVault();

        // Add operator
        vm.prank(admin);
        activeVault.setOperator(operator, true);

        // Fund to target
        _approveAndDeposit(activeVault, user1, FUNDING_TARGET);

        // Activate
        vm.prank(operator);
        activeVault.activateVault();

        return activeVault;
    }

    /**
     * @notice Assert vault state
     */
    function _assertVaultState(
        SingleRWA_Vault _vault,
        ISingleRWA_Vault.VaultState expected
    ) internal view {
        assertEq(
            uint256(_vault.vaultState()),
            uint256(expected),
            "Vault state mismatch"
        );
    }

    /**
     * @notice Calculate expected yield for user
     */
    function _calculateExpectedYield(
        uint256 yieldAmount,
        uint256 userShares,
        uint256 totalShares
    ) internal pure returns (uint256) {
        if (totalShares == 0) return 0;
        return (yieldAmount * userShares) / totalShares;
    }
}
