import { describe, expect, it } from "vitest";
import {
  PRESETS,
  MeteoraError,
  buildPresetConfig,
  getPreset,
  listPresets,
  presetBySlug,
  presetEconomics,
  reviveConfig,
  toPlain,
  validateConfig,
} from "../src/providers/meteora.js";
import { HandlerError, handlers } from "../src/lib/data.js";

const ctx = (params: Record<string, string>) =>
  ({ params }) as unknown as Parameters<(typeof handlers)[string]>[0];

describe("Meteora DBC presets", () => {
  it("ships a preset for every asset class the track named", () => {
    const useCases = new Set(PRESETS.map((p) => p.useCase));
    expect(useCases).toEqual(
      new Set(["community", "equity", "rwa", "ai", "utility"]),
    );
    expect(PRESETS.length).toBeGreaterThanOrEqual(6);
  });

  it("builds every preset and passes Meteora's own validator", () => {
    for (const preset of PRESETS) {
      const economics = presetEconomics(preset);
      expect(economics.validationErrors, preset.slug).toEqual([]);
      expect(economics.valid, preset.slug).toBe(true);
    }
  });

  it("derives a migration threshold and a curve from the market caps", () => {
    for (const preset of PRESETS) {
      const economics = presetEconomics(preset);
      // The SDK, not this repo, computes these; a null here means the builder
      // silently produced something unusable.
      expect(economics.migrationQuoteThreshold, preset.slug).not.toBeNull();
      expect(Number(economics.migrationQuoteThreshold), preset.slug).toBeGreaterThan(0);
      expect(economics.curveSegments, preset.slug).toBeGreaterThan(0);
      expect(economics.upsideMultiple, preset.slug).toBeGreaterThan(1);
    }
  });

  it("keeps fees inside the ranges the DBC program accepts", () => {
    for (const preset of PRESETS) {
      expect(preset.fee.startingFeeBps, preset.slug).toBeGreaterThanOrEqual(0);
      expect(preset.fee.startingFeeBps, preset.slug).toBeLessThanOrEqual(10_000);
      expect(preset.fee.endingFeeBps, preset.slug).toBeGreaterThanOrEqual(0);
      expect(preset.fee.endingFeeBps, preset.slug).toBeLessThanOrEqual(
        preset.fee.startingFeeBps,
      );
      expect(preset.fee.creatorTradingFeePercentage, preset.slug).toBeLessThanOrEqual(50);
    }
  });

  it("serialises BN values so a caller can actually read the config", () => {
    const config = buildPresetConfig(PRESETS[0]);
    const plain = toPlain(config) as Record<string, unknown>;
    expect(plain.migrationQuoteThreshold).toBeTypeOf("string");
    expect(plain.sqrtStartPrice).toBeTypeOf("string");
    // No BN object should survive: they do not serialise.
    const serialised = JSON.stringify(plain);
    expect(serialised).toContain("migrationQuoteThreshold");
    expect(serialised).not.toContain("[object Object]");
  });

  it("returns full config and economics for a known preset", () => {
    const preset = getPreset("equity-paired-low-float");
    expect(preset.name).toBe("Equity-Paired Low Float");
    expect(preset.valid).toBe(true);
    expect(preset.upsideMultiple).toBe(100);
    expect(Object.keys(preset.config).length).toBeGreaterThan(5);
  });

  it("fails loudly on an unknown preset rather than returning an empty config", () => {
    expect(() => getPreset("does-not-exist")).toThrow(MeteoraError);
    try {
      getPreset("does-not-exist");
    } catch (error) {
      expect((error as MeteoraError).code).toBe("PRESET_NOT_FOUND");
    }
    expect(presetBySlug("does-not-exist")).toBeUndefined();
  });

  it("reports validator failures instead of throwing", () => {
    const config = buildPresetConfig(PRESETS[0]);
    const broken = { ...(config as unknown as Record<string, unknown>) };
    // A config with no curve cannot be valid.
    delete broken.curve;
    const result = validateConfig(broken as never);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rehydrates BN values so a JSON config still validates", () => {
    const config = buildPresetConfig(PRESETS[0]);
    const roundTripped = JSON.parse(
      JSON.stringify(toPlain(config)),
    ) as Record<string, unknown>;
    // Straight from JSON every BN is a string, which is what the HTTP surface
    // actually receives.
    expect(roundTripped.migrationQuoteThreshold).toBeTypeOf("string");
    expect(validateConfig(roundTripped as never).valid).toBe(true);
    expect(reviveConfig(roundTripped)).toBeTypeOf("object");
  });

  it("lists every preset with its economics", () => {
    const listing = listPresets();
    expect(listing.presets).toHaveLength(PRESETS.length);
    expect(listing.programId).toBeTypeOf("string");
    for (const item of listing.presets) {
      expect(item.summary.length).toBeGreaterThan(20);
      expect(item.designNotes.length).toBeGreaterThan(40);
    }
  });
});

describe("Meteora gateway handlers", () => {
  it("serves the preset catalogue through the handler", async () => {
    const result = (await handlers["meteora-dbc-presets"](ctx({}))) as {
      presets: unknown[];
    };
    expect(result.presets).toHaveLength(PRESETS.length);
  });

  it("serves a named preset with a serialisable config", async () => {
    const result = (await handlers["meteora-dbc-preset"](
      ctx({ slug: "conviction-exponential" }),
    )) as { valid: boolean; config: Record<string, unknown> };
    expect(result.valid).toBe(true);
    expect(() => JSON.stringify(result.config)).not.toThrow();
    expect(result.config.migrationQuoteThreshold).toBeTypeOf("string");
  });

  it("returns 404 for an unknown preset", async () => {
    const error = (await handlers["meteora-dbc-preset"](
      ctx({ slug: "nope" }),
    ).catch((e: unknown) => e)) as HandlerError;
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(404);
    expect(String(error.message)).toContain("PRESET_NOT_FOUND");
  });

  it("rejects a config that is not a JSON object", async () => {
    const error = (await handlers["meteora-dbc-config-validate"](
      ctx({ config: "not json" }),
    ).catch((e: unknown) => e)) as HandlerError;
    expect(error).toBeInstanceOf(HandlerError);
    expect(error.status).toBe(400);
  });

  it("passes a real preset config through the config doctor", async () => {
    const config = toPlain(buildPresetConfig(PRESETS[1]));
    const result = (await handlers["meteora-dbc-config-validate"](
      ctx({ config: JSON.stringify(config) }),
    )) as { valid: boolean; errors: string[] };
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
