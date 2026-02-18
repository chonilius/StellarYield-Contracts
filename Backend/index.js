import express from 'express';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors());

// ============================================
// CONFIGURATION
// ============================================

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const provider = new ethers.JsonRpcProvider(process.env.STELLAR_RPC_URL);

// Contract ABIs (simplified - import full ABIs in production)
const VAULT_ABI = [
    "function deposit(uint256 assets, address receiver) returns (uint256)",
    "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
    "function claimYield() returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function pendingYield(address) view returns (uint256)",
    "function isKYCVerified(address) view returns (bool)",
    "function totalAssets() view returns (uint256)",
    "function vaultState() view returns (uint8)",
    "function getRWADetails() view returns (tuple(string name, string symbol, string documentURI, string category, uint256 expectedAPY))",
    "function maturityDate() view returns (uint256)",
    "function currentEpoch() view returns (uint256)"
];

const FACTORY_ABI = [
    "function getActiveVaults() view returns (address[])",
    "function getAllVaults() view returns (address[])",
    "function getSingleRWAVaults() view returns (address[])",
    "function getVaultInfo(address) view returns (tuple(address vault, uint8 vaultType, string name, string symbol, bool active, uint256 createdAt))",
    "function isRegisteredVault(address) view returns (bool)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)"
];

// Contract addresses (set via env vars)
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS;

// ============================================
// AI COMMAND PARSER
// ============================================

const SYSTEM_PROMPT = `You are an AI assistant for StellarYield, an RWA (Real World Asset) yield vault platform on Stellar blockchain.

Parse user commands into structured actions. Return ONLY valid JSON, no markdown, no explanation.

Available actions:
1. DEPOSIT - Deposit USDC into a vault
2. WITHDRAW - Withdraw assets from a vault
3. CLAIM_YIELD - Claim pending yield
4. CHECK_BALANCE - Check vault share balance
5. CHECK_YIELD - Check pending yield
6. LIST_VAULTS - List available vaults
7. VAULT_INFO - Get info about a specific vault
8. HELP - Show available commands

Response format (JSON only):
{
    "action": "ACTION_NAME",
    "params": {
        "amount": "number as string if applicable",
        "vaultName": "vault name/keyword if applicable"
    },
    "confidence": 0.0-1.0,
    "clarification": "message if unclear"
}

Examples:
User: "deposit 1000 USDC into the treasury vault"
{"action": "DEPOSIT", "params": {"amount": "1000", "vaultName": "treasury"}, "confidence": 0.95}

User: "how much yield do I have?"
{"action": "CHECK_YIELD", "params": {}, "confidence": 0.98}

User: "what vaults are available?"
{"action": "LIST_VAULTS", "params": {}, "confidence": 0.99}

User: "show me info about the real estate vault"
{"action": "VAULT_INFO", "params": {"vaultName": "real estate"}, "confidence": 0.92}

User: "claim my rewards"
{"action": "CLAIM_YIELD", "params": {}, "confidence": 0.90}

User: "withdraw 500 from treasury"
{"action": "WITHDRAW", "params": {"amount": "500", "vaultName": "treasury"}, "confidence": 0.93}

User: "help"
{"action": "HELP", "params": {}, "confidence": 1.0}

If unclear, set low confidence and provide clarification message.
If not vault-related, politely redirect with action "HELP".`;

async function parseCommand(userMessage) {
    try {
        const result = await model.generateContent([
            { text: SYSTEM_PROMPT },
            { text: `User command: "${userMessage}"` }
        ]);

        const text = result.response.text().trim();

        // Extract JSON from response (handle potential markdown)
        let jsonStr = text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            jsonStr = jsonMatch[0];
        }

        const parsed = JSON.parse(jsonStr);
        console.log("AI parsed:", parsed);
        return parsed;
    } catch (error) {
        console.error("AI parsing error:", error);
        return {
            action: "ERROR",
            params: {},
            confidence: 0,
            clarification: "I couldn't understand that command. Try 'help' to see available commands."
        };
    }
}

// ============================================
// KYC VERIFICATION
// ============================================

async function verifyKYC(userAddress, vaultAddress) {
    try {
        const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
        const isVerified = await vault.isKYCVerified(userAddress);
        return isVerified;
    } catch (error) {
        console.error("KYC verification error:", error);
        // If verification fails, assume not verified for safety
        return false;
    }
}

// ============================================
// TRANSACTION BUILDERS
// ============================================

async function buildDepositTx(userAddress, vaultAddress, amount) {
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

    // Get asset decimals (assuming 6 for USDC)
    const assetAmount = ethers.parseUnits(amount.toString(), 6);

    const txData = vault.interface.encodeFunctionData("deposit", [
        assetAmount,
        userAddress
    ]);

    return {
        to: vaultAddress,
        data: txData,
        value: "0x0"
    };
}

async function buildWithdrawTx(userAddress, vaultAddress, amount) {
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
    const assetAmount = ethers.parseUnits(amount.toString(), 6);

    const txData = vault.interface.encodeFunctionData("withdraw", [
        assetAmount,
        userAddress,
        userAddress
    ]);

    return {
        to: vaultAddress,
        data: txData,
        value: "0x0"
    };
}

async function buildClaimYieldTx(vaultAddress) {
    const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

    const txData = vault.interface.encodeFunctionData("claimYield", []);

    return {
        to: vaultAddress,
        data: txData,
        value: "0x0"
    };
}

async function buildApprovalTx(tokenAddress, spenderAddress, amount) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const assetAmount = ethers.parseUnits(amount.toString(), 6);

    const txData = token.interface.encodeFunctionData("approve", [
        spenderAddress,
        assetAmount
    ]);

    return {
        to: tokenAddress,
        data: txData,
        value: "0x0"
    };
}

// ============================================
// QUERY FUNCTIONS
// ============================================

async function getActiveVaults() {
    try {
        if (!FACTORY_ADDRESS) {
            console.log("Factory address not configured");
            return [];
        }

        const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
        const vaults = await factory.getActiveVaults();

        const vaultInfos = await Promise.all(
            vaults.map(async (vaultAddress) => {
                try {
                    const info = await factory.getVaultInfo(vaultAddress);
                    const vaultContract = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

                    let rwaDetails = null;
                    try {
                        rwaDetails = await vaultContract.getRWADetails();
                    } catch (e) {
                        console.log("Could not fetch RWA details for", vaultAddress);
                    }

                    let totalAssets = "0";
                    try {
                        totalAssets = ethers.formatUnits(await vaultContract.totalAssets(), 6);
                    } catch (e) {
                        console.log("Could not fetch total assets");
                    }

                    return {
                        address: vaultAddress,
                        name: info.name,
                        symbol: info.symbol,
                        active: info.active,
                        createdAt: info.createdAt.toString(),
                        rwaName: rwaDetails?.name || "N/A",
                        rwaCategory: rwaDetails?.category || "N/A",
                        expectedAPY: rwaDetails?.expectedAPY ? (Number(rwaDetails.expectedAPY) / 100).toFixed(2) + "%" : "N/A",
                        totalAssets: totalAssets
                    };
                } catch (error) {
                    console.error("Error fetching vault info:", error);
                    return null;
                }
            })
        );

        return vaultInfos.filter(v => v !== null);
    } catch (error) {
        console.error("Error fetching vaults:", error);
        return [];
    }
}

async function getVaultDetails(vaultAddress) {
    try {
        const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);

        const [rwaDetails, totalAssets, vaultState, maturityDate, currentEpoch] = await Promise.all([
            vault.getRWADetails().catch(() => null),
            vault.totalAssets().catch(() => 0n),
            vault.vaultState().catch(() => 0),
            vault.maturityDate().catch(() => 0n),
            vault.currentEpoch().catch(() => 0n)
        ]);

        const stateNames = ["Funding", "Active", "Matured", "Closed"];

        return {
            address: vaultAddress,
            rwaName: rwaDetails?.name || "N/A",
            rwaSymbol: rwaDetails?.symbol || "N/A",
            rwaCategory: rwaDetails?.category || "N/A",
            documentURI: rwaDetails?.documentURI || "N/A",
            expectedAPY: rwaDetails?.expectedAPY ? (Number(rwaDetails.expectedAPY) / 100).toFixed(2) + "%" : "N/A",
            totalAssets: ethers.formatUnits(totalAssets, 6),
            state: stateNames[Number(vaultState)] || "Unknown",
            maturityDate: maturityDate > 0 ? new Date(Number(maturityDate) * 1000).toISOString() : "N/A",
            currentEpoch: currentEpoch.toString()
        };
    } catch (error) {
        console.error("Error fetching vault details:", error);
        return null;
    }
}

async function getUserBalance(userAddress, vaultAddress) {
    try {
        const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
        const balance = await vault.balanceOf(userAddress);
        return ethers.formatUnits(balance, 6);
    } catch (error) {
        console.error("Error fetching balance:", error);
        return "0";
    }
}

async function getPendingYield(userAddress, vaultAddress) {
    try {
        const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
        const pending = await vault.pendingYield(userAddress);
        return ethers.formatUnits(pending, 6);
    } catch (error) {
        console.error("Error fetching pending yield:", error);
        return "0";
    }
}

async function findVaultByName(name) {
    if (!name) return null;

    const vaults = await getActiveVaults();
    const searchTerm = name.toLowerCase();

    return vaults.find(v =>
        v.name?.toLowerCase().includes(searchTerm) ||
        v.symbol?.toLowerCase().includes(searchTerm) ||
        v.rwaName?.toLowerCase().includes(searchTerm) ||
        v.rwaCategory?.toLowerCase().includes(searchTerm)
    );
}

async function checkAllowance(userAddress, tokenAddress, spenderAddress) {
    try {
        const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
        const allowance = await token.allowance(userAddress, spenderAddress);
        return allowance;
    } catch (error) {
        console.error("Error checking allowance:", error);
        return 0n;
    }
}

// ============================================
// COMMAND EXECUTOR
// ============================================

async function executeCommand(parsedCommand, userAddress) {
    const { action, params, confidence, clarification } = parsedCommand;

    // Low confidence - ask for clarification
    if (confidence < 0.7) {
        return {
            success: false,
            type: "clarification",
            message: clarification || "Could you please rephrase that? Try 'help' for available commands."
        };
    }

    switch (action) {
        case "HELP": {
            return {
                success: true,
                type: "info",
                message: `**StellarYield Commands:**

• **"list vaults"** - See all available vaults
• **"deposit [amount] into [vault]"** - Deposit USDC into a vault
• **"withdraw [amount] from [vault]"** - Withdraw from a vault  
• **"check balance"** - See your vault balances
• **"check yield"** - See your pending yield
• **"claim yield"** - Claim your pending yield
• **"vault info [name]"** - Get details about a vault

Examples:
- "deposit 1000 USDC into treasury vault"
- "how much yield do I have?"
- "show me the real estate vault"`
            };
        }

        case "LIST_VAULTS": {
            const vaults = await getActiveVaults();

            if (vaults.length === 0) {
                return {
                    success: true,
                    type: "info",
                    message: "No active vaults found. The platform may still be setting up.",
                    data: []
                };
            }

            return {
                success: true,
                type: "info",
                message: `Found ${vaults.length} active vault(s):`,
                data: vaults
            };
        }

        case "VAULT_INFO": {
            const vault = await findVaultByName(params.vaultName);
            if (!vault) {
                const vaults = await getActiveVaults();
                return {
                    success: false,
                    type: "error",
                    message: `Vault "${params.vaultName}" not found.`,
                    suggestion: vaults.length > 0
                        ? `Available vaults: ${vaults.map(v => v.name).join(", ")}`
                        : "No vaults available yet."
                };
            }

            const details = await getVaultDetails(vault.address);

            return {
                success: true,
                type: "info",
                message: `Details for ${vault.name}:`,
                data: details
            };
        }

        case "CHECK_BALANCE": {
            if (!userAddress) {
                return {
                    success: false,
                    type: "error",
                    message: "Please connect your wallet first."
                };
            }

            const vault = await findVaultByName(params.vaultName || "");

            // If no vault specified, get all balances
            const vaults = vault ? [vault] : await getActiveVaults();

            if (vaults.length === 0) {
                return {
                    success: true,
                    type: "info",
                    message: "No vaults available to check balance.",
                    data: []
                };
            }

            const balances = await Promise.all(
                vaults.map(async (v) => ({
                    vault: v.name,
                    address: v.address,
                    shares: await getUserBalance(userAddress, v.address)
                }))
            );

            const hasBalance = balances.some(b => parseFloat(b.shares) > 0);

            return {
                success: true,
                type: "info",
                message: hasBalance ? "Your vault balances:" : "You don't have any vault positions yet.",
                data: balances
            };
        }

        case "CHECK_YIELD": {
            if (!userAddress) {
                return {
                    success: false,
                    type: "error",
                    message: "Please connect your wallet first."
                };
            }

            const vault = await findVaultByName(params.vaultName || "");
            const vaults = vault ? [vault] : await getActiveVaults();

            if (vaults.length === 0) {
                return {
                    success: true,
                    type: "info",
                    message: "No vaults available.",
                    data: []
                };
            }

            const yields = await Promise.all(
                vaults.map(async (v) => ({
                    vault: v.name,
                    address: v.address,
                    pendingYield: await getPendingYield(userAddress, v.address)
                }))
            );

            const totalYield = yields.reduce((sum, y) => sum + parseFloat(y.pendingYield), 0);

            return {
                success: true,
                type: "info",
                message: totalYield > 0
                    ? `You have ${totalYield.toFixed(2)} USDC in pending yield:`
                    : "You don't have any pending yield to claim.",
                data: yields
            };
        }

        case "DEPOSIT": {
            if (!userAddress) {
                return {
                    success: false,
                    type: "error",
                    message: "Please connect your wallet first."
                };
            }

            if (!params.amount || parseFloat(params.amount) <= 0) {
                return {
                    success: false,
                    type: "clarification",
                    message: "Please specify a valid deposit amount. Example: 'deposit 1000 USDC into treasury vault'"
                };
            }

            const vault = await findVaultByName(params.vaultName);
            if (!vault) {
                const vaults = await getActiveVaults();
                return {
                    success: false,
                    type: "error",
                    message: `Vault "${params.vaultName || 'unspecified'}" not found.`,
                    suggestion: vaults.length > 0
                        ? `Available vaults: ${vaults.map(v => v.name).join(", ")}`
                        : "No vaults available yet."
                };
            }

            // Verify KYC
            const isKYCVerified = await verifyKYC(userAddress, vault.address);
            if (!isKYCVerified) {
                return {
                    success: false,
                    type: "kyc_required",
                    message: "KYC verification required. Please complete verification through zkMe first.",
                    action: "OPEN_KYC_WIDGET"
                };
            }

            // Check if approval is needed
            const currentAllowance = await checkAllowance(userAddress, USDC_ADDRESS, vault.address);
            const depositAmount = ethers.parseUnits(params.amount.toString(), 6);
            const needsApproval = currentAllowance < depositAmount;

            // Build transaction(s)
            const transactions = [];

            if (needsApproval) {
                const approvalTx = await buildApprovalTx(USDC_ADDRESS, vault.address, params.amount);
                transactions.push({
                    type: "approval",
                    description: `Approve ${params.amount} USDC`,
                    ...approvalTx
                });
            }

            const depositTx = await buildDepositTx(userAddress, vault.address, params.amount);
            transactions.push({
                type: "deposit",
                description: `Deposit ${params.amount} USDC into ${vault.name}`,
                ...depositTx
            });

            return {
                success: true,
                type: "transaction",
                message: `Ready to deposit ${params.amount} USDC into ${vault.name}`,
                vaultAddress: vault.address,
                transactions,
                needsApproval
            };
        }

        case "WITHDRAW": {
            if (!userAddress) {
                return {
                    success: false,
                    type: "error",
                    message: "Please connect your wallet first."
                };
            }

            if (!params.amount || parseFloat(params.amount) <= 0) {
                return {
                    success: false,
                    type: "clarification",
                    message: "Please specify a valid withdrawal amount. Example: 'withdraw 500 from treasury vault'"
                };
            }

            const vault = await findVaultByName(params.vaultName);
            if (!vault) {
                const vaults = await getActiveVaults();
                return {
                    success: false,
                    type: "error",
                    message: `Vault "${params.vaultName || 'unspecified'}" not found.`,
                    suggestion: vaults.length > 0
                        ? `Available vaults: ${vaults.map(v => v.name).join(", ")}`
                        : "No vaults available."
                };
            }

            // Check user balance
            const balance = await getUserBalance(userAddress, vault.address);
            if (parseFloat(balance) < parseFloat(params.amount)) {
                return {
                    success: false,
                    type: "error",
                    message: `Insufficient balance. You have ${balance} shares in ${vault.name}.`
                };
            }

            const tx = await buildWithdrawTx(userAddress, vault.address, params.amount);

            return {
                success: true,
                type: "transaction",
                message: `Ready to withdraw ${params.amount} USDC from ${vault.name}`,
                vaultAddress: vault.address,
                transactions: [{
                    type: "withdraw",
                    description: `Withdraw ${params.amount} USDC from ${vault.name}`,
                    ...tx
                }]
            };
        }

        case "CLAIM_YIELD": {
            if (!userAddress) {
                return {
                    success: false,
                    type: "error",
                    message: "Please connect your wallet first."
                };
            }

            const vault = await findVaultByName(params.vaultName || "");
            const vaults = vault ? [vault] : await getActiveVaults();

            // Filter to vaults with pending yield
            const vaultsWithYield = [];
            for (const v of vaults) {
                const pending = await getPendingYield(userAddress, v.address);
                if (parseFloat(pending) > 0) {
                    vaultsWithYield.push({
                        ...v,
                        pendingYield: pending
                    });
                }
            }

            if (vaultsWithYield.length === 0) {
                return {
                    success: false,
                    type: "info",
                    message: "You don't have any yield to claim."
                };
            }

            const transactions = await Promise.all(
                vaultsWithYield.map(async (v) => {
                    const tx = await buildClaimYieldTx(v.address);
                    return {
                        type: "claim",
                        vaultName: v.name,
                        vaultAddress: v.address,
                        amount: v.pendingYield,
                        description: `Claim ${v.pendingYield} USDC from ${v.name}`,
                        ...tx
                    };
                })
            );

            const totalYield = vaultsWithYield.reduce((sum, v) => sum + parseFloat(v.pendingYield), 0);

            return {
                success: true,
                type: "transaction_batch",
                message: `Ready to claim ${totalYield.toFixed(2)} USDC in yield`,
                transactions
            };
        }

        case "ERROR":
        default:
            return {
                success: false,
                type: "error",
                message: clarification || "I couldn't understand that command. Try 'help' for available commands."
            };
    }
}

// ============================================
// API ENDPOINTS
// ============================================

/**
 * @route POST /api/command
 * @desc Process a user command via AI
 * @body { command: string, userAddress: string }
 */
app.post('/api/command', async (req, res) => {
    try {
        const { command, userAddress } = req.body;

        if (!command) {
            return res.status(400).json({
                success: false,
                message: "Missing command"
            });
        }

        // Validate address format if provided
        if (userAddress && !ethers.isAddress(userAddress)) {
            return res.status(400).json({
                success: false,
                message: "Invalid wallet address"
            });
        }

        // Parse command with AI
        const parsedCommand = await parseCommand(command);
        console.log("Parsed command:", parsedCommand);

        // Execute command
        const result = await executeCommand(parsedCommand, userAddress);

        return res.json(result);
    } catch (error) {
        console.error("Command processing error:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

/**
 * @route GET /api/vaults
 * @desc Get all active vaults
 */
app.get('/api/vaults', async (req, res) => {
    try {
        const vaults = await getActiveVaults();
        return res.json({ success: true, data: vaults });
    } catch (error) {
        console.error("Error fetching vaults:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch vaults"
        });
    }
});

/**
 * @route GET /api/vaults/:address
 * @desc Get details about a specific vault
 */
app.get('/api/vaults/:address', async (req, res) => {
    try {
        const { address } = req.params;

        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                message: "Invalid vault address"
            });
        }

        const details = await getVaultDetails(address);

        if (!details) {
            return res.status(404).json({
                success: false,
                message: "Vault not found"
            });
        }

        return res.json({ success: true, data: details });
    } catch (error) {
        console.error("Error fetching vault details:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch vault details"
        });
    }
});

/**
 * @route GET /api/user/:address/balances
 * @desc Get user's balances across all vaults
 */
app.get('/api/user/:address/balances', async (req, res) => {
    try {
        const { address } = req.params;

        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address"
            });
        }

        const vaults = await getActiveVaults();
        const balances = await Promise.all(
            vaults.map(async (v) => ({
                vault: v.name,
                address: v.address,
                shares: await getUserBalance(address, v.address),
                pendingYield: await getPendingYield(address, v.address)
            }))
        );

        return res.json({ success: true, data: balances });
    } catch (error) {
        console.error("Error fetching balances:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch balances"
        });
    }
});

/**
 * @route GET /api/user/:address/yield
 * @desc Get user's pending yield across all vaults
 */
app.get('/api/user/:address/yield', async (req, res) => {
    try {
        const { address } = req.params;

        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address"
            });
        }

        const vaults = await getActiveVaults();
        const yields = await Promise.all(
            vaults.map(async (v) => ({
                vault: v.name,
                address: v.address,
                pendingYield: await getPendingYield(address, v.address)
            }))
        );

        const totalYield = yields.reduce((sum, y) => sum + parseFloat(y.pendingYield), 0);

        return res.json({
            success: true,
            data: yields,
            totalPendingYield: totalYield.toFixed(6)
        });
    } catch (error) {
        console.error("Error fetching yield:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch yield"
        });
    }
});

/**
 * @route GET /api/kyc/:address
 * @desc Check KYC status for a user
 */
app.get('/api/kyc/:address', async (req, res) => {
    try {
        const { address } = req.params;
        const { vault } = req.query;

        if (!ethers.isAddress(address)) {
            return res.status(400).json({
                success: false,
                message: "Invalid address"
            });
        }

        if (!vault || !ethers.isAddress(vault)) {
            return res.status(400).json({
                success: false,
                message: "Vault address required as query param"
            });
        }

        const isVerified = await verifyKYC(address, vault);

        return res.json({
            success: true,
            data: {
                address,
                vault,
                isKYCVerified: isVerified
            }
        });
    } catch (error) {
        console.error("Error checking KYC:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to check KYC status"
        });
    }
});

/**
 * @route GET /health
 * @desc Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        config: {
            factoryConfigured: !!FACTORY_ADDRESS,
            usdcConfigured: !!USDC_ADDRESS,
            rpcConfigured: !!process.env.STELLAR_RPC_URL,
            aiConfigured: !!process.env.GEMINI_API_KEY
        }
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           StellarYield API Server                          ║
╠═══════════════════════════════════════════════════════════╣
║  Port:     ${PORT}                                            ║
║  Factory:  ${FACTORY_ADDRESS ? FACTORY_ADDRESS.slice(0, 10) + '...' : 'Not configured'}                           ║
║  USDC:     ${USDC_ADDRESS ? USDC_ADDRESS.slice(0, 10) + '...' : 'Not configured'}                           ║
║  RPC:      ${process.env.STELLAR_RPC_URL ? 'Configured' : 'Not configured'}                                  ║
║  AI:       ${process.env.GEMINI_API_KEY ? 'Configured' : 'Not configured'}                                  ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
