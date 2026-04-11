export const GNOSIS_CHAIN_ID = "0x64";
export const XBZZ_TOKEN = "0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da";
export const XBZZ_DECIMALS = 16;

/** Storage size presets matching beeport (depth -> human-readable capacity) */
export const SIZE_OPTIONS = [
  { depth: 19, label: "110 MB" },
  { depth: 20, label: "680 MB" },
  { depth: 21, label: "2.6 GB" },
  { depth: 22, label: "7.7 GB" },
  { depth: 23, label: "20 GB" },
  { depth: 24, label: "47 GB" },
  { depth: 25, label: "105 GB" },
  { depth: 26, label: "227 GB" },
  { depth: 27, label: "476 GB" },
];

/** Duration presets matching beeport */
export const DURATION_OPTIONS = [
  { days: 1, label: "~1 day" },
  { days: 2, label: "~2 days" },
  { days: 7, label: "~7 days" },
  { days: 15, label: "~15 days" },
  { days: 30, label: "~30 days" },
  { days: 90, label: "~90 days" },
  { days: 180, label: "~180 days" },
  { days: 365, label: "~1 year" },
];

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function formatBZZ(plur: string) {
  try {
    const n = BigInt(plur);
    const whole = n / BigInt(10 ** XBZZ_DECIMALS);
    const frac = n % BigInt(10 ** XBZZ_DECIMALS);
    const fracStr = frac.toString().padStart(XBZZ_DECIMALS, "0").slice(0, 4);
    return `${whole}.${fracStr}`;
  } catch {
    return plur;
  }
}

export function formatDAI(wei: string) {
  try {
    const n = BigInt(wei);
    const whole = n / BigInt(10 ** 18);
    const frac = n % BigInt(10 ** 18);
    const fracStr = frac.toString().padStart(18, "0").slice(0, 4);
    return `${whole}.${fracStr}`;
  } catch {
    return wei;
  }
}

/** Validate a hex address — accepts with or without 0x prefix, 40 hex chars */
export function isValidHexAddress(addr: string) {
  const trimmed = addr.trim().replace(/^0x/i, "");
  return /^[a-fA-F0-9]{40}$/.test(trimmed);
}

/** Normalize: ensure 0x prefix */
export function normalizeAddr(addr: string) {
  const trimmed = addr.trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

export async function ensureGnosisChain() {
  const eth = (window as any).ethereum;
  if (!eth) throw new Error("No wallet found");
  try {
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: GNOSIS_CHAIN_ID }],
    });
  } catch (switchErr: unknown) {
    const code = (switchErr as { code?: number }).code;
    if (code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: GNOSIS_CHAIN_ID,
            chainName: "Gnosis Chain",
            nativeCurrency: { name: "xDAI", symbol: "xDAI", decimals: 18 },
            rpcUrls: ["https://rpc.gnosischain.com"],
            blockExplorerUrls: ["https://gnosisscan.io"],
          },
        ],
      });
    } else {
      throw switchErr;
    }
  }
}

export async function sendXDAI(to: string, amountWei: string) {
  await ensureGnosisChain();
  const eth = (window as any).ethereum!;
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  return eth.request({
    method: "eth_sendTransaction",
    params: [{ from, to, value: "0x" + BigInt(amountWei).toString(16) }],
  }) as Promise<string>;
}

export async function sendXBZZ(to: string, amountPlur: string) {
  await ensureGnosisChain();
  const eth = (window as any).ethereum!;
  const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
  const from = accounts[0];
  const amt = BigInt(amountPlur).toString(16).padStart(64, "0");
  const toStripped = to.replace("0x", "").padStart(64, "0");
  const data = "0xa9059cbb" + toStripped + amt;
  return eth.request({
    method: "eth_sendTransaction",
    params: [{ from, to: XBZZ_TOKEN, data }],
  }) as Promise<string>;
}
