/* eslint-disable no-undef */
/* eslint-disable no-unused-vars */
/**
 * Channel analysis child worker.
 * Receives channel data (via SAB pointer or postMessage), runs WASM analyze_channel_messages,
 * and returns the ChannelAnalysis result.
 */

const workerScope: any = self;

// WASM module reference
let wasmAnalyzeChannelMessages: ((raw: string, format: number, options: number) => string) | null = null;
let wasmInitPromise: Promise<void> | null = null;

// Options bitmask constants — must match lib.rs
const OPT_FAVORITE_WORDS = 1 << 0;
const OPT_CURSED = 1 << 1;
const OPT_LINKS = 1 << 2;
const OPT_DISCORD_LINKS = 1 << 3;
const OPT_EMOJIS = 1 << 4;
const OPT_CUSTOM_EMOJIS = 1 << 5;
const OPT_MENTIONS = 1 << 6;
const OPT_HOURS = 1 << 7;
const OPT_OLDEST = 1 << 8;
const OPT_ATTACHMENTS = 1 << 9;
const OPT_CHAR_COUNT = 1 << 10;

async function initWasm(): Promise<void> {
  if (wasmAnalyzeChannelMessages) return;
  if (wasmInitPromise) return wasmInitPromise;

  wasmInitPromise = (async () => {
    try {
      const moduleUrl = new URL("/wasm/discord_package_wasm.js", workerScope.location.origin).toString();
      const wasmUrl = new URL("/wasm/discord_package_wasm_bg.wasm", workerScope.location.origin).toString();
      const wasmModule: any = await import(/* webpackIgnore: true */ moduleUrl);
      await wasmModule.default(wasmUrl);

      wasmAnalyzeChannelMessages = (raw: string, format: number, options: number) => {
        return wasmModule.analyze_channel_messages(raw, format, options);
      };
    } catch {
      wasmAnalyzeChannelMessages = null;
    }
  })();

  try {
    await wasmInitPromise;
  } finally {
    wasmInitPromise = null;
  }
}

/** Convert options object to bitmask */
function optionsToBitmask(options: any): number {
  let mask = 0;
  if (options?.other?.favoriteWords) mask |= OPT_FAVORITE_WORDS;
  if (options?.other?.showCurseWords) mask |= OPT_CURSED;
  if (options?.other?.showLinks) mask |= OPT_LINKS;
  if (options?.other?.showDiscordLinks) mask |= OPT_DISCORD_LINKS;
  if (options?.messages?.topEmojis || options?.other?.topEmojis) mask |= OPT_EMOJIS;
  if (options?.messages?.topCustomEmojis || options?.other?.topCustomEmojis) mask |= OPT_CUSTOM_EMOJIS;
  if (options?.messages?.mentionCount) mask |= OPT_MENTIONS;
  if (options?.messages?.hoursValues) mask |= OPT_HOURS;
  if (options?.other?.oldestMessages || options?.messages?.oldestMessages) mask |= OPT_OLDEST;
  if (options?.messages?.attachmentCount) mask |= OPT_ATTACHMENTS;
  if (options?.messages?.characterCount) mask |= OPT_CHAR_COUNT;
  return mask;
}

export type ChannelWorkerRequest = {
  type: "analyze";
  id: string; // request/channel identifier for correlation
  rawText: string; // channel messages raw text (Tier 2: sent via postMessage)
  format: number; // 0=JSON, 1=CSV
  options: any;
  channelMeta: {
    name: string;
    channelId?: string;
    userId?: string;
    userTag?: string;
    recipients?: number;
    isDM: boolean;
    isGroupDM: boolean;
    hasGuild: boolean;
    guildName?: string;
  };
} | {
  type: "analyze-sab";
  id: string;
  sabRef: SharedArrayBuffer;
  offset: number;
  length: number;
  format: number;
  options: any;
  channelMeta: {
    name: string;
    channelId?: string;
    userId?: string;
    userTag?: string;
    recipients?: number;
    isDM: boolean;
    isGroupDM: boolean;
    hasGuild: boolean;
    guildName?: string;
  };
} | {
  type: "init";
};

workerScope.onmessage = async (event: MessageEvent<ChannelWorkerRequest>) => {
  const msg = event.data;

  if (msg.type === "init") {
    await initWasm();
    workerScope.postMessage({ type: "ready" });
    return;
  }

  if (msg.type === "analyze" || msg.type === "analyze-sab") {
    await initWasm();

    let rawText: string;
    if (msg.type === "analyze-sab") {
      // Read from SharedArrayBuffer
      const view = new Uint8Array(msg.sabRef, msg.offset, msg.length);
      rawText = new TextDecoder().decode(view);
    } else {
      rawText = msg.rawText;
    }

    const bitmask = optionsToBitmask(msg.options);

    let analysis: any;
    if (wasmAnalyzeChannelMessages) {
      try {
        const resultJson = wasmAnalyzeChannelMessages(rawText, msg.format, bitmask);
        analysis = JSON.parse(resultJson);
      } catch {
        // WASM failed, will be null
        analysis = null;
      }
    }

    if (!analysis) {
      // Send back null — coordinator will use JS fallback for this channel
      workerScope.postMessage({
        type: "result",
        id: msg.id,
        analysis: null,
        meta: msg.channelMeta,
      });
      return;
    }

    // Attach channel metadata to the analysis
    workerScope.postMessage({
      type: "result",
      id: msg.id,
      analysis,
      meta: msg.channelMeta,
    });
  }
};

export {};
