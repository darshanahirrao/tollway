/**
 * Meteora Dynamic Bonding Curve (DBC) provider.
 *
 * The Meteora track asks for a config preset marketplace that builders can pay
 * to use, and for developer tooling that launchpads can plug in. This module is
 * both: a validated library of curve presets, priced per call, plus a config
 * doctor that runs the official SDK validator.
 *
 * Presets are built with `buildCurveWithMarketCap` rather than hand-written
 * JSON, so the SDK derives the curve, the sqrt prices and the migration
 * threshold from the two market caps. A preset is structurally correct by
 * construction and is re-checked before it is served.
 *
 * Docs: https://docs.meteora.ag/developer-guides/dbc
 */

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithMarketCap,
  validateConfigParameters,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

export class MeteoraError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "MeteoraError";
  }
}

export interface PresetDefinition {
  slug: string;
  name: string;
  summary: string;
  useCase: "community" | "equity" | "rwa" | "ai" | "utility";
  designNotes: string;
  token: {
    decimals: TokenDecimal;
    totalSupply: number;
    tokenType?: TokenType;
    authorityOption?: TokenAuthorityOption;
    leftover?: number;
  };
  curve: {
    initialMarketCap: number;
    migrationMarketCap: number;
  };
  fee: {
    startingFeeBps: number;
    endingFeeBps: number;
    numberOfPeriods: number;
    totalDurationSeconds: number;
    /** Only the two scheduler modes are valid for new configs. */
    feeMode:
      | BaseFeeMode.FeeSchedulerLinear
      | BaseFeeMode.FeeSchedulerExponential;
    creatorTradingFeePercentage: number;
    dynamicFeeEnabled: boolean;
    collectFeeMode: CollectFeeMode;
  };
  lockedVesting: {
    totalLockedVestingAmount: number;
    numberOfVestingPeriod: number;
    cliffUnlockAmount: number;
    totalVestingDuration: number;
    cliffDurationFromMigrationTime: number;
  };
  liquidityDistribution: {
    partnerPermanentLockedLiquidityPercentage: number;
    partnerLiquidityPercentage: number;
    creatorPermanentLockedLiquidityPercentage: number;
    creatorLiquidityPercentage: number;
  };
}

const BILLION = 1_000_000_000;

/**
 * DBC requires the four liquidity percentages to sum to exactly 100. The
 * default mirrors a standard launch: 90% of migrated liquidity belongs to the
 * creator, 10% is permanently locked so the pool can never be pulled.
 * (Vesting percentages count toward the same 100 and are left unset here.)
 */
const DEFAULT_LIQUIDITY = {
  partnerPermanentLockedLiquidityPercentage: 0,
  partnerLiquidityPercentage: 0,
  creatorPermanentLockedLiquidityPercentage: 10,
  creatorLiquidityPercentage: 90,
};

/** A heavier lock for assets whose buyers are underwriting a real claim. */
const HEAVY_LIQUIDITY = {
  partnerPermanentLockedLiquidityPercentage: 0,
  partnerLiquidityPercentage: 0,
  creatorPermanentLockedLiquidityPercentage: 30,
  creatorLiquidityPercentage: 70,
};

const NO_LOCKED_VESTING = {
  totalLockedVestingAmount: 0,
  numberOfVestingPeriod: 0,
  cliffUnlockAmount: 0,
  totalVestingDuration: 0,
  cliffDurationFromMigrationTime: 0,
};

/**
 * Six presets covering the asset classes the track named. The market caps are
 * the knobs that matter: the ratio between them is the upside a buyer is
 * taking, and the migration cap sets how much liquidity has to be raised.
 */
export const PRESETS: PresetDefinition[] = [
  {
    slug: "standard-community-launch",
    name: "Standard Community Launch",
    summary:
      "The default DBC launch: 1B supply, 5k to 500k market cap, linear fee decay over 24 hours.",
    useCase: "community",
    designNotes:
      "A 100x curve with a linear fee schedule that starts high enough to blunt snipers and decays to a normal fee inside a day. Use it when the asset is the community itself.",
    token: { decimals: TokenDecimal.NINE, totalSupply: BILLION },
    curve: { initialMarketCap: 5_000, migrationMarketCap: 500_000 },
    fee: {
      startingFeeBps: 1_000,
      endingFeeBps: 100,
      numberOfPeriods: 24,
      totalDurationSeconds: 86_400,
      feeMode: BaseFeeMode.FeeSchedulerLinear,
      creatorTradingFeePercentage: 10,
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
    },
    lockedVesting: NO_LOCKED_VESTING,
    liquidityDistribution: DEFAULT_LIQUIDITY,
  },
  {
    slug: "equity-paired-low-float",
    name: "Equity-Paired Low Float",
    summary:
      "Tuned for tokenized equity: 100M supply, 50k to 5M market cap, immutable authority after launch.",
    useCase: "equity",
    designNotes:
      "Tokenized equity needs a low float and a credible ceiling. The 100x cap keeps the launch valuation legible next to the underlying name, and immutable authority removes the objection a stock trader raises first about onchain wrappers.",
    token: {
      decimals: TokenDecimal.SIX,
      totalSupply: 100_000_000,
      authorityOption: TokenAuthorityOption.Immutable,
    },
    curve: { initialMarketCap: 50_000, migrationMarketCap: 5_000_000 },
    fee: {
      startingFeeBps: 500,
      endingFeeBps: 30,
      numberOfPeriods: 48,
      totalDurationSeconds: 172_800,
      feeMode: BaseFeeMode.FeeSchedulerLinear,
      creatorTradingFeePercentage: 20,
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
    },
    lockedVesting: NO_LOCKED_VESTING,
    liquidityDistribution: DEFAULT_LIQUIDITY,
  },
  {
    slug: "deep-liquidity-gradual",
    name: "Deep Liquidity Gradual",
    summary:
      "10B supply, 20k to 2M curve, for launches that want low price impact over a long accumulation window.",
    useCase: "utility",
    designNotes:
      "More supply across the same quote depth means each buy moves the price less. Useful when the token is working utility and you would rather have a wide holder base than a violent chart.",
    token: { decimals: TokenDecimal.NINE, totalSupply: 10 * BILLION },
    curve: { initialMarketCap: 20_000, migrationMarketCap: 2_000_000 },
    fee: {
      startingFeeBps: 300,
      endingFeeBps: 50,
      numberOfPeriods: 72,
      totalDurationSeconds: 604_800,
      feeMode: BaseFeeMode.FeeSchedulerLinear,
      creatorTradingFeePercentage: 15,
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
    },
    lockedVesting: NO_LOCKED_VESTING,
    liquidityDistribution: DEFAULT_LIQUIDITY,
  },
  {
    slug: "conviction-exponential",
    name: "Conviction Exponential",
    summary:
      "Exponential fee decay: expensive in the first minutes, cheap for whoever is still holding at graduation.",
    useCase: "ai",
    designNotes:
      "Linear decay treats every minute as equally risky. Exponential decay front-loads the cost of entering early, which is exactly the window when the buyers you want are the ones who read the docs.",
    token: { decimals: TokenDecimal.NINE, totalSupply: BILLION },
    curve: { initialMarketCap: 15_000, migrationMarketCap: 3_000_000 },
    fee: {
      startingFeeBps: 2_000,
      endingFeeBps: 50,
      numberOfPeriods: 36,
      totalDurationSeconds: 259_200,
      feeMode: BaseFeeMode.FeeSchedulerExponential,
      creatorTradingFeePercentage: 25,
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
    },
    lockedVesting: NO_LOCKED_VESTING,
    liquidityDistribution: DEFAULT_LIQUIDITY,
  },
  {
    slug: "rwa-paired-vesting",
    name: "RWA Paired With Vesting",
    summary:
      "Real-world-asset preset: immutable supply, a 1.5B locked tranche, and a one-month curve.",
    useCase: "rwa",
    designNotes:
      "RWA buyers ask two questions a memecoin never gets: who controls supply, and when does it unlock. Immutable authority answers the first; onchain vesting with a cliff answers the second without a legal promise.",
    token: {
      decimals: TokenDecimal.NINE,
      totalSupply: 2 * BILLION,
      authorityOption: TokenAuthorityOption.Immutable,
    },
    curve: { initialMarketCap: 100_000, migrationMarketCap: 10_000_000 },
    fee: {
      startingFeeBps: 300,
      endingFeeBps: 25,
      numberOfPeriods: 30,
      totalDurationSeconds: 2_592_000,
      feeMode: BaseFeeMode.FeeSchedulerLinear,
      creatorTradingFeePercentage: 20,
      dynamicFeeEnabled: false,
      collectFeeMode: CollectFeeMode.QuoteToken,
    },
    lockedVesting: {
      totalLockedVestingAmount: 1_500_000_000,
      numberOfVestingPeriod: 12,
      cliffUnlockAmount: 0,
      totalVestingDuration: 31_536_000,
      cliffDurationFromMigrationTime: 7_776_000,
    },
    liquidityDistribution: HEAVY_LIQUIDITY,
  },
  {
    slug: "agent-token-creator-share",
    name: "Agent Token, Creator Share",
    summary:
      "AI agent token: a 500k to 25M curve with a 30% creator trading share so the agent funds its own compute.",
    useCase: "ai",
    designNotes:
      "An agent that pays for its own inference needs revenue before it needs a treasury. A higher creator trading share routes fees to the operator continuously instead of in one unlock.",
    token: { decimals: TokenDecimal.EIGHT, totalSupply: BILLION },
    curve: { initialMarketCap: 500_000, migrationMarketCap: 25_000_000 },
    fee: {
      startingFeeBps: 800,
      endingFeeBps: 40,
      numberOfPeriods: 24,
      totalDurationSeconds: 86_400,
      feeMode: BaseFeeMode.FeeSchedulerLinear,
      creatorTradingFeePercentage: 30,
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
    },
    lockedVesting: NO_LOCKED_VESTING,
    liquidityDistribution: DEFAULT_LIQUIDITY,
  },
];

export function presetBySlug(slug: string): PresetDefinition | undefined {
  return PRESETS.find((p) => p.slug === slug);
}

/** Builds a DBC config from a preset using the official SDK curve builder. */
export function buildPresetConfig(preset: PresetDefinition): ConfigParameters {
  return buildCurveWithMarketCap({
    token: {
      tokenType: preset.token.tokenType ?? TokenType.SPLToken,
      tokenBaseDecimal: preset.token.decimals,
      tokenQuoteDecimal: 6,
      tokenAuthorityOption:
        preset.token.authorityOption ??
        TokenAuthorityOption.CreatorUpdateAuthority,
      totalTokenSupply: preset.token.totalSupply,
      leftover: preset.token.leftover ?? 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: preset.fee.feeMode,
        feeSchedulerParam: {
          startingFeeBps: preset.fee.startingFeeBps,
          endingFeeBps: preset.fee.endingFeeBps,
          numberOfPeriod: preset.fee.numberOfPeriods,
          totalDuration: preset.fee.totalDurationSeconds,
        },
      },
      dynamicFeeEnabled: preset.fee.dynamicFeeEnabled,
      collectFeeMode: preset.fee.collectFeeMode,
      creatorTradingFeePercentage: preset.fee.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: preset.liquidityDistribution,
    lockedVesting: preset.lockedVesting,
    activationType: ActivationType.Timestamp,
    initialMarketCap: preset.curve.initialMarketCap,
    migrationMarketCap: preset.curve.migrationMarketCap,
  });
}

/**
 * BN values do not survive JSON.stringify, and a preset the caller cannot read
 * is useless. This converts every BN in the tree to a decimal string.
 */
export function toPlain(value: unknown): unknown {
  if (BN.isBN(value)) return (value as BN).toString(10);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPlain(inner);
    }
    return out;
  }
  return value;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * ConfigParameters carries BN values, which do not survive a JSON round trip.
 * A config that arrives over HTTP is therefore all strings, and Meteora's
 * validator does BN arithmetic on it, so the BN fields have to be rebuilt
 * before validation. These are exactly the paths a built config puts a BN on.
 */
const BN_FIELD_NAMES = new Set([
  "cliffFeeNumerator",
  "secondFactor",
  "thirdFactor",
  "binStepU128",
  "migrationQuoteThreshold",
  "sqrtStartPrice",
  "sqrtPrice",
  "liquidity",
  "amountPerPeriod",
  "cliffDurationFromMigrationTime",
  "frequency",
  "numberOfPeriod",
  "cliffUnlockAmount",
  "preMigrationTokenSupply",
  "postMigrationTokenSupply",
  "poolCreationFee",
  "reductionFactor",
]);

export function reviveConfig(value: unknown, key = ""): unknown {
  // A BN is an object, so it has to be returned before the object branch walks
  // its internals and destroys it.
  if (BN.isBN(value)) return value;
  if (Array.isArray(value)) return value.map((item) => reviveConfig(item, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [innerKey, innerValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[innerKey] = reviveConfig(innerValue, innerKey);
    }
    return out;
  }
  if (typeof value === "string" && BN_FIELD_NAMES.has(key) && /^\d+$/.test(value)) {
    return new BN(value);
  }
  return value;
}

/**
 * Runs Meteora's own validator over a config. The SDK expects the create-config
 * account list alongside the parameters, so placeholder keys are supplied. The
 * validator checks the numbers and their relationships, which is the part a
 * builder actually gets wrong.
 */
export function validateConfig(config: ConfigParameters): ValidationResult {
  // The supply check rejects the all-zero key, and no real account is being
  // validated here, so the incinerator address is used as an obvious stand-in.
  const placeholder = new PublicKey(
    "1nc1nerator11111111111111111111111111111111",
  );
  try {
    validateConfigParameters({
      ...(reviveConfig(config) as Record<string, unknown>),
      config: placeholder,
      feeClaimer: placeholder,
      quoteMint: placeholder,
      payer: placeholder,
      // The supply check derives the leftover receiver, so a placeholder is
      // required even though account existence is not what is being validated.
      leftoverReceiver: placeholder,
    } as never);
    return { valid: true, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      errors: message.split("\n").map((l) => l.trim()).filter(Boolean),
    };
  }
}

export interface PresetEconomics {
  slug: string;
  name: string;
  useCase: string;
  initialMarketCap: number;
  migrationMarketCap: number;
  upsideMultiple: number;
  totalSupply: number;
  decimals: number;
  startingFeeBps: number;
  endingFeeBps: number;
  creatorTradingFeePercentage: number;
  dynamicFeeEnabled: boolean;
  migrationQuoteThreshold: string | null;
  curveSegments: number;
  programId: string;
  valid: boolean;
  validationErrors: string[];
}

function curveSegments(config: ConfigParameters): number {
  const curve = (config as unknown as { curve?: unknown[] }).curve;
  return Array.isArray(curve) ? curve.length : 0;
}

function migrationThreshold(config: ConfigParameters): string | null {
  const value = (config as unknown as { migrationQuoteThreshold?: unknown })
    .migrationQuoteThreshold;
  return BN.isBN(value) ? (value as BN).toString(10) : null;
}

export function presetEconomics(preset: PresetDefinition): PresetEconomics {
  const config = buildPresetConfig(preset);
  const validation = validateConfig(config);
  return {
    slug: preset.slug,
    name: preset.name,
    useCase: preset.useCase,
    initialMarketCap: preset.curve.initialMarketCap,
    migrationMarketCap: preset.curve.migrationMarketCap,
    upsideMultiple: Number(
      (
        preset.curve.migrationMarketCap / preset.curve.initialMarketCap
      ).toFixed(2),
    ),
    totalSupply: preset.token.totalSupply,
    decimals: preset.token.decimals,
    startingFeeBps: preset.fee.startingFeeBps,
    endingFeeBps: preset.fee.endingFeeBps,
    creatorTradingFeePercentage: preset.fee.creatorTradingFeePercentage,
    dynamicFeeEnabled: preset.fee.dynamicFeeEnabled,
    migrationQuoteThreshold: migrationThreshold(config),
    curveSegments: curveSegments(config),
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
    valid: validation.valid,
    validationErrors: validation.errors,
  };
}

/** Catalogue view: what a builder needs in order to choose between presets. */
export function listPresets() {
  return {
    programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
    presets: PRESETS.map((preset) => ({
      ...presetEconomics(preset),
      summary: preset.summary,
      designNotes: preset.designNotes,
    })),
  };
}

/** Full preset: economics plus the exact ConfigParameters to hand to the SDK. */
export function getPreset(slug: string) {
  const preset = presetBySlug(slug);
  if (!preset) {
    throw new MeteoraError(`Unknown preset: ${slug}`, "PRESET_NOT_FOUND");
  }
  return {
    ...presetEconomics(preset),
    summary: preset.summary,
    designNotes: preset.designNotes,
    config: toPlain(buildPresetConfig(preset)) as Record<string, unknown>,
  };
}
