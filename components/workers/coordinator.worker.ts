/* eslint-disable no-mixed-spaces-and-tabs */
/* eslint-disable no-undef */
/**
 * Coordinator worker — orchestrates parallel package processing.
 *
 * Tier 1: SharedArrayBuffer + worker pool + WASM
 * Tier 2: Worker pool + postMessage + WASM
 * Tier 3 fallback: delegates to the legacy package.worker.ts path (handled by Upload.tsx)
 */
import { AsyncUnzipInflate, DecodeUTF8, Unzip } from "fflate";
import Utils from "../utils";
import BitField from "../utils/Bitfield";
import { BumpAllocator, hasSABSupport } from "./shared-memory";

function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

type WorkerMessage = {
  type: "start";
  file: File;
  options: any;
  debug?: boolean;
};

type SnapshotStage =
  | "user"
  | "messages"
  | "guilds"
  | "bots"
  | "badges"
  | "statistics";

const workerScope: any = self;

const MESSAGES_REGEX = /Messages\/(c)?([0-9]{16,32})\/channel\.json$/;
const ANALYTICS_FILE_REGEX = /Activity\/analytics\/events-[0-9]{4}-[0-9]{5}-of-[0-9]{5}\.json$/;
const GLOBAL_OLDEST_MESSAGES_LIMIT = 1000;
const GUILD_OLDEST_MESSAGES_LIMIT = 100;
const ATTACHMENT_PREVIEW_LIMIT = 1000;

let lastProgressAt = 0;
let lastProgressPercent = -1;
let wasmScanAnalyticsEvents: ((text: string, eventNamesJson: string) => string) | null = null;
let wasmAnalyticsInitPromise: Promise<void> | null = null;

type AnalyticsPattern = {
  originalName: string;
  snakeName: string;
  length: number;
};

async function ensureWasmAnalyticsScanner() {
  if (wasmScanAnalyticsEvents) {
    return wasmScanAnalyticsEvents;
  }

  if (wasmAnalyticsInitPromise) {
    await wasmAnalyticsInitPromise;
    return wasmScanAnalyticsEvents;
  }

  wasmAnalyticsInitPromise = (async () => {
    try {
      const moduleUrl = new URL("/wasm/discord_package_wasm.js", workerScope.location.origin).toString();
      const wasmUrl = new URL("/wasm/discord_package_wasm_bg.wasm", workerScope.location.origin).toString();
      const wasmModule: any = await import(
        /* webpackIgnore: true */ moduleUrl
      );

      await wasmModule.default(wasmUrl);
      wasmScanAnalyticsEvents = (text: string, eventNamesJson: string) => {
        if (!text) {
          return "{}";
        }

        return wasmModule.scan_analytics_events(text, eventNamesJson);
      };
    } catch {
      wasmScanAnalyticsEvents = null;
    }
  })();

  try {
    await wasmAnalyticsInitPromise;
  } finally {
    wasmAnalyticsInitPromise = null;
  }

  return wasmScanAnalyticsEvents;
}

function createAnalyticsPatterns(eventNames: string[]) {
  const counts: Record<string, number> = {};
  const patternsByFirstChar: Record<string, AnalyticsPattern[]> = {};
  let maxPatternLength = 1;

  for (const originalName of eventNames) {
    counts[originalName] = 0;
    const snakeName = toSnakeCase(originalName);
    const pattern: AnalyticsPattern = {
      originalName,
      snakeName,
      length: snakeName.length,
    };

    const firstChar = snakeName.charAt(0);
    if (!patternsByFirstChar[firstChar]) {
      patternsByFirstChar[firstChar] = [];
    }
    patternsByFirstChar[firstChar].push(pattern);
    if (snakeName.length > maxPatternLength) {
      maxPatternLength = snakeName.length;
    }
  }

  return {
    counts,
    maxPatternLength,
    patternsByFirstChar,
  };
}

function scanAnalyticsChunk(
  chunk: string,
  carry: string,
  patternsByFirstChar: Record<string, AnalyticsPattern[]>,
  counts: Record<string, number>,
  maxPatternLength: number,
  final: boolean,
) {
  const combined = carry + chunk;
  const carryLength = carry.length;

  for (let index = 0; index < combined.length; index++) {
    const candidates = patternsByFirstChar[combined.charAt(index)];
    if (!candidates?.length) continue;

    for (const candidate of candidates) {
      const endIndex = index + candidate.length;
      if (endIndex > combined.length) continue;
      if (!combined.startsWith(candidate.snakeName, index)) continue;
      if (!final && endIndex <= carryLength) continue;
      if (final && endIndex <= carryLength) continue;
      counts[candidate.originalName]++;
    }
  }

  if (final) {
    return "";
  }

  const overlapLength = Math.max(0, maxPatternLength - 1);
  return combined.length > overlapLength ? combined.slice(-overlapLength) : combined;
}

function mergeAnalyticsCounts(
  target: Record<string, number>,
  source: Record<string, number> | null | undefined,
) {
  if (!source) return;

  for (const [eventName, count] of Object.entries(source)) {
    if (!count) continue;
    target[eventName] = (target[eventName] || 0) + count;
  }
}



function createEmptyPackageData() {
  return {
    user: {
      id: null,
      username: null,
      discriminator: null,
      avatar: null,
      premium_until: null,
      flags: null,
      badges: [],
    },
    settings: {
      appearance: null,
      recentEmojis: [],
    },
    connections: [],
    bots: [],
    payments: {
      total: null,
      transactions: [],
      giftedNitro: {},
    },
    messages: {
      topChannels: [],
      topDMs: [],
      topGuilds: [],
      topGroupDMs: [],
      characterCount: null,
      messageCount: null,
      hoursValues: {
        hourly: Array.from({ length: 24 }, () => 0),
        daily: Array.from({ length: 7 }, () => 0),
        monthly: Array.from({ length: 12 }, () => 0),
        yearly: [],
      },
      oldestMessages: [],
      attachmentCount: [],
      attachmentCountTotal: 0,
      mentionCount: {
        channel: 0,
        user: 0,
        role: 0,
        here: 0,
        everyone: 0,
      },
      topCustomEmojis: [],
      topEmojis: [],
      favoriteWords: [],
      topCursed: [],
      topLinks: [],
      topDiscordLinks: [],
    },
    guilds: {},
    statistics: {
      openCount: null,
      averageOpenCount: {
        day: null,
        week: null,
        month: null,
        year: null,
      },
      notificationCount: null,
      joinedVoiceChannelsCount: null,
      joinedCallsCount: null,
      reactionsAddedCount: null,
      messageEditCount: null,
      sendMessage: null,
      averageMessages: {
        day: null,
        week: null,
        month: null,
        year: null,
      },
    },
  };
}

function postSnapshot(stage: SnapshotStage, data: any) {
  workerScope.postMessage({ type: "snapshot", stage, data });
}

function postProgress(percent: number, label: string, detail: string = "") {
  const now = Date.now();
  if (percent === lastProgressPercent && now - lastProgressAt < 16) return;
  lastProgressAt = now;
  lastProgressPercent = percent;
  workerScope.postMessage({ type: "progress", percent, label, detail });
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown package processing error";
}



async function loadZipEntries(file: Blob) {
  const files: Array<any> = [];
  const reader = new Unzip();
  reader.register(AsyncUnzipInflate);
  reader.onfile = (file) => { files.push(file); };

  if (typeof file.stream === "function") {
    const fileReader = file.stream().getReader();
    while (true) {
      const chunk = await fileReader.read();
      if (chunk.done) {
        reader.push(new Uint8Array(0), true);
        break;
      }
      const value = chunk.value;
      if (!value?.length) continue;
      for (let index = 0; index < value.length; index += 65536) {
        reader.push(value.subarray(index, index + 65536));
      }
    }
  } else {
    const buffer = await file.arrayBuffer();
    reader.push(new Uint8Array(buffer), true);
  }

  return files;
}

async function readEntry(name: string, files: Array<any>, debug: boolean = false) {
  return Utils.readFile(name, files, { debug });
}

async function readJsonEntry(name: string, files: Array<any>, debug: boolean = false) {
  const raw = await readEntry(name, files, debug);
  if (!raw) return null;
  return JSON.parse(raw);
}

function releaseEntriesByName(files: Array<any>, entryNames: string[]) {
  if (!Array.isArray(files) || !entryNames.length) return;

  const names = new Set(entryNames);
  for (let index = files.length - 1; index >= 0; index--) {
    if (names.has(files[index]?.name)) {
      files.splice(index, 1);
    }
  }
}

function releaseEntriesByPattern(files: Array<any>, predicate: (file: any) => boolean) {
  if (!Array.isArray(files)) return;

  for (let index = files.length - 1; index >= 0; index--) {
    if (predicate(files[index])) {
      files.splice(index, 1);
    }
  }
}

function incrementMap(target: Map<string, number>, key: string, count: number = 1) {
  target.set(key, (target.get(key) || 0) + count);
}

function mergeEntriesIntoMap(items: Array<any> | null | undefined, keyName: string, target: Map<string, number>) {
  if (!items) return;
  for (const item of items) {
    const key = item?.[keyName];
    const count = item?.count;
    if (!key || !count) continue;
    incrementMap(target, key, count);
  }
}

function mapToSortedArray(target: Map<string, number>, keyName: string, limit: number) {
  return Array.from(target.entries())
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
}

function trimOldestMessages(messages: Array<any>, limit: number) {
  return messages
    .sort((left, right) =>
      new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
    )
    .slice(0, limit);
}

function mergeOldestMessagesLimited(target: Array<any>, source: Array<any> | null | undefined, limit: number) {
  if (!source?.length) return;
  target.push(...source);
  if (target.length <= limit) return;

  const trimmed = trimOldestMessages(target, limit);
  target.length = 0;
  target.push(...trimmed);
}

function appendAttachmentPreview(target: string[], source: string[] | null | undefined, limit: number) {
  if (!source?.length || target.length >= limit) return;

  const remaining = limit - target.length;
  if (remaining <= 0) return;
  target.push(...source.slice(0, remaining));
}

// ─── Worker Pool Management ───

type PoolWorker = {
  worker: Worker;
  busy: boolean;
  id: number;
};

function detectPoolSize(): number {
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
  return Math.max(2, Math.min(cores, 8));
}

function createWorkerPool(size: number): Promise<PoolWorker[]> {
  const pool: PoolWorker[] = [];
  const readyPromises: Promise<void>[] = [];

  for (let i = 0; i < size; i++) {
    const worker = new Worker(
      new URL("./channel.worker.ts", import.meta.url),
      { type: "module" }
    );
    const pw: PoolWorker = { worker, busy: false, id: i };
    pool.push(pw);

    const ready = new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data?.type === "ready") {
          worker.removeEventListener("message", handler);
          resolve();
        }
      };
      worker.addEventListener("message", handler);
    });
    readyPromises.push(ready);
    worker.postMessage({ type: "init" });
  }

  return Promise.all(readyPromises).then(() => pool);
}

function terminatePool(pool: PoolWorker[]) {
  for (const pw of pool) {
    pw.worker.terminate();
  }
}

type ChannelTask = {
  channelID: string;
  rawText: string;
  format: number;
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
};

function dispatchToPool(
  pool: PoolWorker[],
  task: ChannelTask,
  options: any,
  useSAB: boolean,
  allocator: BumpAllocator | null,
): Promise<any> {
  return new Promise((resolve) => {
    const tryDispatch = () => {
      const free = pool.find((pw) => !pw.busy);
      if (!free) {
        // All workers busy — retry after a microtask
        setTimeout(tryDispatch, 1);
        return;
      }

      free.busy = true;

      const handler = (event: MessageEvent) => {
        if (event.data?.id !== task.channelID) return;
        free.worker.removeEventListener("message", handler);
        free.busy = false;
        resolve(event.data);
      };
      free.worker.addEventListener("message", handler);

      if (useSAB && allocator) {
        const encoded = new TextEncoder().encode(task.rawText);
        const region = allocator.write(encoded);
        free.worker.postMessage({
          type: "analyze-sab",
          id: task.channelID,
          sabRef: region.buffer,
          offset: region.offset,
          length: region.length,
          format: task.format,
          options,
          channelMeta: task.channelMeta,
        });
      } else {
        free.worker.postMessage({
          type: "analyze",
          id: task.channelID,
          rawText: task.rawText,
          format: task.format,
          options,
          channelMeta: task.channelMeta,
        });
      }
    };

    tryDispatch();
  });
}

// ─── Parallel Channel Processing ───

async function buildChannelsParallel(
  files: Array<any>,
  userMessages: Record<string, string>,
  userId: string,
  hasMessagesIndex: boolean,
  debug: boolean,
  options: any,
) {
  const channelsIDFILE = files.filter((file: any) => file?.name && MESSAGES_REGEX.test(file.name));
  if (!channelsIDFILE[0]?.name) {
    throw new Error("invalid_package_missing_messages");
  }

  const isOldPackage = channelsIDFILE[0].name.match(MESSAGES_REGEX)?.[1] === undefined;
  const channelsIDs = channelsIDFILE
    .map((file: any) => file?.name?.match(MESSAGES_REGEX)?.[2] || null)
    .filter(Boolean);

  const firstChannelID = channelsIDs[0];
  const firstChannelMessagesPath = `Messages/${isOldPackage ? "" : "c"}${firstChannelID}/messages.json`;
  const firstChannelMessages = await readEntry(firstChannelMessagesPath, files, debug);
  const extension = firstChannelMessages ? "json" : "csv";
  const format = extension === "csv" ? 1 : 0;

  // Detect tier
  const useSAB = hasSABSupport();
  const poolSize = detectPoolSize();

  postProgress(28, "Loading Messages", `Spawning ${poolSize} workers (${useSAB ? "shared memory" : "message passing"})`);

  let pool: PoolWorker[];
  try {
    pool = await createWorkerPool(poolSize);
  } catch {
    // Worker pool failed — fall back to single-threaded
    pool = [];
  }

  const allocator = useSAB ? new BumpAllocator() : null;

  const globalFavoriteWordsMap = new Map<string, number>();
  const globalTopCursedMap = new Map<string, number>();
  const globalTopLinksMap = new Map<string, number>();
  const globalTopDiscordLinksMap = new Map<string, number>();
  const globalTopEmojisMap = new Map<string, number>();
  const globalTopCustomEmojisMap = new Map<string, number>();
  const globalOldestMessages: Array<any> = [];
  const globalAttachments: string[] = [];
  const globalMentionCount = { channel: 0, user: 0, role: 0, here: 0, everyone: 0 };
  const globalHoursValues = {
    hourly: Array.from({ length: 24 }, () => 0),
    daily: Array.from({ length: 7 }, () => 0),
    monthly: Array.from({ length: 12 }, () => 0),
    yearly: new Map<string, number>(),
  };
  let globalAttachmentTotal = 0;

  let totalCharacterCount = 0;
  let totalMessageCount = 0;
  let messagesRead = 0;
  let processedChannels = 0;
  const analyzedChannels: Array<any> = [];
  const totalChannels = channelsIDs.length;

  // Process in batches of pool size * 2 for I/O pipelining
  const batchSize = pool.length > 0 ? poolSize * 2 : 25;
  for (let batchStart = 0; batchStart < totalChannels; batchStart += batchSize) {
    const batchIDs = channelsIDs.slice(batchStart, batchStart + batchSize);

    if (allocator) allocator.reset();

    // Phase 1: Read channel files (parallel I/O)
    const channelReads = await Promise.all(
      batchIDs.map(async (channelID) => {
        const channelDataPath = `Messages/${isOldPackage ? "" : "c"}${channelID}/channel.json`;
        const channelMessagesPath = `Messages/${isOldPackage ? "" : "c"}${channelID}/messages.${extension}`;

        try {
          const [rawData, rawMessages] = await Promise.all([
            readEntry(channelDataPath, files, debug),
            readEntry(channelMessagesPath, files, debug),
          ]);

          if (!rawData || !rawMessages) return null;

          const data_ = JSON.parse(rawData);
          releaseEntriesByName(files, [channelDataPath, channelMessagesPath]);

          if (!hasMessagesIndex && data_?.id && !userMessages[data_.id]) {
            if (data_?.name) {
              userMessages[data_.id] = data_.name;
            } else if (data_?.recipients?.length > 0) {
              userMessages[data_.id] = data_.recipients[0];
            } else {
              userMessages[data_.id] = `Channel_${data_.id}`;
            }
          }

          const name = data_?.id && userMessages?.[data_.id]
            ? String(userMessages[data_.id]).replace("#0", "")
            : "Unknown";
          const isDM = data_?.recipients && data_?.recipients?.length === 2;
          const dmUserID = isDM
            ? data_.recipients.find((recipientId: string) => recipientId !== userId)
            : undefined;
          const isGroupDM = !data_?.guild && !isDM && data_?.recipients?.length > 1 && !dmUserID;
          const hasGuild = !!data_?.guild;

          return {
            channelID,
            rawMessages: rawMessages as string,
            meta: {
              name,
              channelId: data_?.id,
              userId: dmUserID,
              userTag: isDM && name.includes("Direct Message with")
                ? name.split("Direct Message with")[1].trim()
                : undefined,
              recipients: data_?.recipients?.length,
              isDM,
              isGroupDM,
              hasGuild,
              guildName: data_?.guild?.name,
            },
          };
        } catch {
          return null;
        }
      })
    );

    // Phase 2: Dispatch to worker pool (or process in-thread if no pool)
    const validChannels = channelReads.filter(Boolean) as Array<{
      channelID: string;
      rawMessages: string;
      meta: any;
    }>;

    let results: Array<any>;

    if (pool.length > 0) {
      // Parallel dispatch
      const resultPromises = validChannels.map((ch) =>
        dispatchToPool(
          pool,
          {
            channelID: ch.channelID,
            rawText: ch.rawMessages,
            format,
            channelMeta: ch.meta,
          },
          options,
          useSAB,
          allocator,
        )
      );
      results = await Promise.all(resultPromises);
    } else {
      // Single-threaded fallback (shouldn't normally happen — Upload.tsx handles Tier 3)
      results = validChannels.map((ch) => ({
        type: "result",
        id: ch.channelID,
        analysis: null, // Will trigger JS fallback below
        meta: ch.meta,
      }));
    }

    // Phase 3: Merge results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const ch = validChannels[i];
      if (!result || !ch) continue;

      let analysis = result.analysis;
      const meta = result.meta || ch.meta;

      // JS fallback if WASM returned null
      if (!analysis) {
        try {
          const messages = extension === "csv"
            ? Utils.parseCSV(ch.rawMessages)
            : Utils.parseJSON(ch.rawMessages, { entryName: `Messages/c${ch.channelID}/messages.${extension}` });
          analysis = analyzeChannelJS(messages, options);
        } catch {
          continue;
        }
      }

      messagesRead++;
      const channelResult = {
        name: meta.name,
        messageCount: analysis.messageCount || 0,
        guildName: meta.guildName,
        favoriteWords: analysis.favoriteWords?.slice(0, 1000) || null,
        topCursed: analysis.topCursed?.slice(0, 1000) || null,
        topLinks: analysis.topLinks?.slice(0, 1000) || null,
        topDiscordLinks: analysis.topDiscordLinks?.slice(0, 1000) || null,
        oldestMessages: analysis.oldestMessages || null,
        topEmojis: analysis.topEmojis || null,
        topCustomEmojis: analysis.topCustomEmojis || null,
        channel_id: meta.channelId,
        user_id: meta.userId,
        user_tag: meta.userTag,
        recipients: meta.recipients,
        isDM: meta.isDM,
        isGroupDM: meta.isGroupDM,
        hasGuild: meta.hasGuild,
        characterCount: analysis.characterCount || 0,
        mentionCount: analysis.mentionCount || { channel: 0, user: 0, role: 0, here: 0, everyone: 0 },
        hoursValues: analysis.hoursValues || null,
      };

      analyzedChannels.push(channelResult);
      totalMessageCount += channelResult.messageCount;
      totalCharacterCount += channelResult.characterCount;

      mergeEntriesIntoMap(channelResult.favoriteWords, "word", globalFavoriteWordsMap);
      mergeEntriesIntoMap(channelResult.topCursed, "word", globalTopCursedMap);
      mergeEntriesIntoMap(channelResult.topLinks, "word", globalTopLinksMap);
      mergeEntriesIntoMap(channelResult.topDiscordLinks, "word", globalTopDiscordLinksMap);
      mergeEntriesIntoMap(channelResult.topEmojis, "emoji", globalTopEmojisMap);
      mergeEntriesIntoMap(channelResult.topCustomEmojis, "emoji", globalTopCustomEmojisMap);

      if (channelResult.oldestMessages) {
        mergeOldestMessagesLimited(globalOldestMessages, channelResult.oldestMessages, GLOBAL_OLDEST_MESSAGES_LIMIT);
      }
      if (analysis.attachments?.length) {
        globalAttachmentTotal += analysis.attachments.length;
        appendAttachmentPreview(globalAttachments, analysis.attachments, ATTACHMENT_PREVIEW_LIMIT);
      }
      if (channelResult.mentionCount) {
        globalMentionCount.channel += channelResult.mentionCount.channel || 0;
        globalMentionCount.user += channelResult.mentionCount.user || 0;
        globalMentionCount.role += channelResult.mentionCount.role || 0;
        globalMentionCount.here += channelResult.mentionCount.here || 0;
        globalMentionCount.everyone += channelResult.mentionCount.everyone || 0;
      }
      if (channelResult.hoursValues) {
        (channelResult.hoursValues.hourly || []).forEach((count: number, index: number) => {
          globalHoursValues.hourly[index] += count;
        });
        (channelResult.hoursValues.daily || []).forEach((count: number, index: number) => {
          globalHoursValues.daily[index] += count;
        });
        (channelResult.hoursValues.monthly || []).forEach((count: number, index: number) => {
          globalHoursValues.monthly[index] += count;
        });
        const yearly = channelResult.hoursValues.yearly || {};
        Object.entries(yearly).forEach(([year, count]) => {
          globalHoursValues.yearly.set(year, (globalHoursValues.yearly.get(year) || 0) + Number(count));
        });
      }

      ch.rawMessages = "";
      result.analysis = null;
    }

    channelReads.length = 0;
    validChannels.length = 0;
    results.length = 0;

    processedChannels += batchIDs.length;
    const progress = Math.min(75, 30 + Math.round((processedChannels / totalChannels) * 45));
    postProgress(progress, "Loading Messages", `${Math.min(processedChannels, totalChannels)}/${totalChannels} channels processed`);
  }

  // Cleanup
  if (pool.length > 0) {
    terminatePool(pool);
  }

  if (messagesRead === 0) {
    throw new Error("invalid_package_missing_messages");
  }

  return {
    analyzedChannels,
    globalFavoriteWords: mapToSortedArray(globalFavoriteWordsMap, "word", 1000),
    globalTopCursed: mapToSortedArray(globalTopCursedMap, "word", 1000),
    globalTopLinks: mapToSortedArray(globalTopLinksMap, "word", 1000),
    globalTopDiscordLinks: mapToSortedArray(globalTopDiscordLinksMap, "word", 1000),
    globalTopEmojis: mapToSortedArray(globalTopEmojisMap, "emoji", 1000),
    globalTopCustomEmojis: mapToSortedArray(globalTopCustomEmojisMap, "emoji", 1000),
    globalOldestMessages: trimOldestMessages(globalOldestMessages, GLOBAL_OLDEST_MESSAGES_LIMIT),
    globalAttachments,
    globalAttachmentTotal,
    globalMentionCount,
    globalHoursValues: {
      hourly: globalHoursValues.hourly,
      daily: globalHoursValues.daily,
      monthly: globalHoursValues.monthly,
      yearly: Array.from(globalHoursValues.yearly.values()),
    },
    totalCharacterCount,
    totalMessageCount,
  };
}

// ─── JS Fallback Channel Analysis ───
// Used when WASM is unavailable or fails for a channel.

const EMOJI_REGEX = /\ud83c[\udf00-\udfff]|\ud83d[\udc00-\ude4f]|\ud83d[\ude80-\udeff]/g;
const CUSTOM_EMOJI_REGEX = /<a?:[a-zA-Z0-9_]+:(\d+)>/g;
const ATTACHMENT_REGEX = /(https?:\/\/.*\.(?:png|jpg|jpeg|gif|mp4|pdf|zip|wmv|mp3|nitf|doc|docx))/gi;
const TENOR_GIF_REGEX = /https?:\/\/(c\.tenor\.com\/([^ /\n]+)\/([^ /\n]+)\.gif|tenor\.com\/view\/(?:.*-)?([^ /\n]+))/gi;
const CHANNEL_MENTION_REGEX = /<#[0-9]*>/gi;
const USER_MENTION_REGEX = /<@[0-9]*>/gi;
const ROLE_MENTION_REGEX = /<@&[0-9]*>/gi;

function analyzeChannelJS(messages: Array<any>, options: any) {
  const joinedParts: string[] = [];
  const oldestMessages: Array<any> = [];
  const attachments: string[] = [];
  const hoursValues = {
    hourly: Array.from({ length: 24 }, () => 0),
    daily: Array.from({ length: 7 }, () => 0),
    monthly: Array.from({ length: 12 }, () => 0),
    yearly: {} as Record<string, number>,
  };

  let characterCount = 0;
  const shouldCollectOldest = options?.other?.oldestMessages || options?.messages?.oldestMessages;

  for (const message of messages) {
    const words = Array.isArray(message?.words) ? message.words : [];
    if (words.length) {
      joinedParts.push(words.join(" "));
    }

    if (options?.messages?.characterCount) {
      characterCount += message?.length || 0;
    }

    if (options?.messages?.hoursValues && message?.timestamp) {
      const date = new Date(message.timestamp);
      if (!Number.isNaN(date.getTime())) {
        hoursValues.hourly[date.getHours()]++;
        hoursValues.daily[date.getDay()]++;
        hoursValues.monthly[date.getMonth()]++;
        const year = String(date.getFullYear());
        hoursValues.yearly[year] = (hoursValues.yearly[year] || 0) + 1;
      }
    }

    if (shouldCollectOldest && message?.timestamp) {
      oldestMessages.push({
        sentence: words.join(" "),
        timestamp: message.timestamp,
      });
    }

    if (options?.messages?.attachmentCount) {
      for (const word of words) {
        if (!word) continue;
        ATTACHMENT_REGEX.lastIndex = 0;
        TENOR_GIF_REGEX.lastIndex = 0;
        if (!ATTACHMENT_REGEX.test(word) && !TENOR_GIF_REGEX.test(word)) continue;
        ATTACHMENT_REGEX.lastIndex = 0;
        TENOR_GIF_REGEX.lastIndex = 0;
        const attachment = ATTACHMENT_REGEX.test(word)
          ? word.match(ATTACHMENT_REGEX)?.[0]
          : TENOR_GIF_REGEX.test(word)
            ? word.match(TENOR_GIF_REGEX)?.[0]
            : word;
        if (attachment && attachment.length > 25) {
          attachments.push(attachment.replace(/[`"|'{}[\]]/g, ""));
        }
      }
    }
  }

  const joinedText = joinedParts.join(" ");
  const splitWords = joinedText.split(/\s+/).filter(Boolean);

  const favoriteWords = options?.other?.favoriteWords ? Utils.getFavoriteWords(splitWords) : null;
  const topCursed = options?.other?.showCurseWords
    ? Utils.getCursedWords(splitWords.filter((word: string) => word.length < 10 && !/[^\w\s]/g.test(word)))
    : null;
  const topLinks = options?.other?.showLinks ? Utils.getTopLinks(splitWords) : null;
  const topDiscordLinks = options?.other?.showDiscordLinks ? Utils.getDiscordLinks(splitWords) : null;

  let topEmojis = null;
  if (options?.messages?.topEmojis || options?.other?.topEmojis) {
    const emojiMap = new Map<string, number>();
    const emojiChars = joinedText.match(EMOJI_REGEX) || [];
    for (const emoji of emojiChars) incrementMap(emojiMap, emoji);
    topEmojis = mapToSortedArray(emojiMap, "emoji", 1000);
  }

  let topCustomEmojis = null;
  if (options?.messages?.topCustomEmojis || options?.other?.topCustomEmojis) {
    const emojiMap = new Map<string, number>();
    const emojiChars = joinedText.toLowerCase().match(CUSTOM_EMOJI_REGEX) || [];
    for (const emoji of emojiChars) incrementMap(emojiMap, emoji);
    topCustomEmojis = mapToSortedArray(emojiMap, "emoji", 1000);
  }

  let mentionCount = { channel: 0, user: 0, role: 0, here: 0, everyone: 0 };
  if (options?.messages?.mentionCount) {
    mentionCount = {
      channel: (joinedText.match(CHANNEL_MENTION_REGEX) || []).length,
      user: (joinedText.match(USER_MENTION_REGEX) || []).length,
      role: (joinedText.match(ROLE_MENTION_REGEX) || []).length,
      here: (joinedText.match(/@here/g) || []).length,
      everyone: (joinedText.match(/@everyone/g) || []).length,
    };
  }

  return {
    messageCount: messages.length,
    characterCount,
    favoriteWords: favoriteWords?.slice(0, 1000) || null,
    topCursed: topCursed?.slice(0, 1000) || null,
    topLinks: topLinks?.slice(0, 1000) || null,
    topDiscordLinks: topDiscordLinks?.slice(0, 1000) || null,
    topEmojis,
    topCustomEmojis,
    mentionCount,
    hoursValues,
    oldestMessages: shouldCollectOldest ? trimOldestMessages(oldestMessages, 100) : null,
    attachments,
  };
}

// ─── Streaming Analytics Scanner ───
// Single-pass chunk-by-chunk scanner. Each event is scanned independently
// via indexOf (backed by native C++ in JS engines). A carry tail of
// (maxEventLen - 1) chars bridges chunk boundaries without double-counting.

async function streamAnalytics(
  analyticsFiles: Array<any>,
  eventNames: string[],
  onProgress: (percent: number, label: string, detail: string) => void,
): Promise<Record<string, number>> {
  const files = Array.isArray(analyticsFiles) ? analyticsFiles.filter(Boolean) : [];
  const { counts, maxPatternLength, patternsByFirstChar } = createAnalyticsPatterns(eventNames);
  const wasmAnalyticsScanner = await ensureWasmAnalyticsScanner();
  const eventNamesJson = JSON.stringify(eventNames);
  const overlapLength = Math.max(0, maxPatternLength - 1);
  const totalSize = files.reduce((sum, file) => sum + (file?.originalSize || 0), 0);
  let totalBytesRead = 0;
  const startAt = Date.now();

  for (const analyticsFile of files) {
    await new Promise<void>((resolve) => {
      const decoder = new DecodeUTF8();
      let finished = false;
      let carry = "";

      analyticsFile.ondata = (err: any, data: Uint8Array, final: boolean) => {
        if (finished) return;
        if (err) {
          finished = true;
          resolve();
          return;
        }

        totalBytesRead += data?.length || 0;
        try {
          decoder.push(data, final);
        } catch {
          finished = true;
          resolve();
        }
      };

      decoder.ondata = (str: string, final: boolean) => {
        const combined = carry + str;
        const scanText = final
          ? combined
          : combined.length > overlapLength
            ? combined.slice(0, -overlapLength)
            : "";

        carry = final
          ? ""
          : combined.length > overlapLength
            ? combined.slice(-overlapLength)
            : combined;

        if (scanText) {
          if (wasmAnalyticsScanner) {
            try {
              const chunkCounts = JSON.parse(
                wasmAnalyticsScanner(scanText, eventNamesJson)
              ) as Record<string, number>;
              mergeAnalyticsCounts(counts, chunkCounts);
            } catch {
              scanAnalyticsChunk(
                scanText,
                "",
                patternsByFirstChar,
                counts,
                maxPatternLength,
                true,
              );
            }
          } else {
            scanAnalyticsChunk(
              scanText,
              "",
              patternsByFirstChar,
              counts,
              maxPatternLength,
              true,
            );
          }
        }

        if (totalSize > 0) {
          const pct = Math.min(99, Math.ceil((totalBytesRead / totalSize) * 100));
          const elapsed = (Date.now() - startAt) / 1000;
          const remaining = elapsed > 0 && totalBytesRead > 0
            ? Math.ceil(((totalSize - totalBytesRead) / totalBytesRead) * elapsed)
            : 0;

          onProgress(
            92 + Math.floor(pct * 0.07),
            `Loading Analytics: ${pct}%`,
            `~${remaining + 1}s remaining`,
          );
        }

        if (final) {
          finished = true;
          resolve();
        }
      };

      analyticsFile.start();
    });
  }

  return counts;
}

// ─── Main Package Extraction ───

async function extractPackageData(files: Array<any>, options: any, debug: boolean) {
  const data: any = createEmptyPackageData();

  postProgress(5, "Loading User Information");
  let userInformationData = await readJsonEntry("Account/user.json", files, debug);
  if (!userInformationData?.id) {
    throw new Error("User ID not found");
  }

  data.user.id = userInformationData.id;
  data.user.username = userInformationData.username || null;
  if (userInformationData.discriminator) {
    let discriminator = userInformationData.discriminator;
    if (discriminator > 0 && discriminator < 10) {
      discriminator = `000${discriminator}`;
    }
    data.user.discriminator = discriminator;
  }
  if (userInformationData.avatar_hash) {
    data.user.avatar = userInformationData.avatar_hash;
  }
  if (options?.user?.premium_until && userInformationData.premium_until) {
    data.user.premium_until = userInformationData.premium_until;
  }

  if (userInformationData.settings?.settings && options?.settings?.appearance) {
    data.settings.appearance = userInformationData.settings.settings.appearance || null;
  }

  if (userInformationData.settings?.frecency?.emojiFrecency?.emojis && options?.settings?.recentEmojis) {
    const emojis = Object.keys(userInformationData.settings.frecency.emojiFrecency.emojis).map((key: string) => ({
      name: key,
      count: userInformationData.settings.frecency.emojiFrecency.emojis[key]?.totalUses,
    }));
    data.settings.recentEmojis = emojis;
  }

  if (options?.connections && Array.isArray(userInformationData.connections)) {
    const connections = userInformationData.connections
      .filter((connection: any) => connection.type !== "contacts")
      .map((connection: any) => ({
        type: connection.type,
        name: connection.name,
        visible: connection.visibility !== 0,
        id: connection.id,
      }));
    data.connections = connections.length ? connections : null;
  }

  if (userInformationData.entitlements && options?.payments?.giftedNitro) {
    const giftedNitro: Record<string, number> = {};
    Object.values(userInformationData.entitlements).forEach((entry: any) => {
      const name = entry?.subscription_plan?.name;
      if (!name) return;
      giftedNitro[name] = (giftedNitro[name] || 0) + 1;
    });
    data.payments.giftedNitro = Object.keys(giftedNitro).length ? giftedNitro : null;
  }

  const confirmedPayments = (userInformationData?.payments || []).filter((payment: any) => payment.status === 1);
  if (confirmedPayments.length) {
    if (options?.payments?.total) {
      data.payments.total = confirmedPayments
        .map((payment: any) => payment.amount / 100)
        .reduce((previous: number, current: number) => previous + current, 0);
    }

    if (options?.payments?.transactions) {
      data.payments.transactions = confirmedPayments
        .sort((left: any, right: any) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime())
        .map((payment: any) => ({
          information: payment.description,
          amount: payment.amount / 100,
          currency: payment.currency,
          date: payment.created_at,
        }));
    }
  }

  postSnapshot("user", data);

  postProgress(25, "Loading Messages", "Preparing parallel channel scan");

  const hasMessagesIndex = files.some((file: any) => file.name === "Messages/index.json");
  const hasServersIndex = files.some((file: any) => file.name === "Servers/index.json");
  let userMessages: Record<string, string> = {};

  if (hasMessagesIndex) {
    userMessages = (await readJsonEntry("Messages/index.json", files, debug)) || {};
  }

  const messageResults = await buildChannelsParallel(files, userMessages, data.user.id, hasMessagesIndex, debug, options);

  if (options?.messages?.topChannels) {
    data.messages.topChannels = messageResults.analyzedChannels
      .filter((channel: any) => channel.hasGuild)
      .sort((left: any, right: any) => right.messageCount - left.messageCount);
  }

  if (options?.messages?.topDMs) {
    data.messages.topDMs = messageResults.analyzedChannels
      .filter((channel: any) => channel.isDM && channel.name.includes("Direct Message with"))
      .sort((left: any, right: any) => right.messageCount - left.messageCount);
  }

  if (options?.messages?.topGroupDMs) {
    data.messages.topGroupDMs = messageResults.analyzedChannels
      .filter((channel: any) => channel.isGroupDM)
      .sort((left: any, right: any) => right.messageCount - left.messageCount);
  }

  if (options?.messages?.topGuilds) {
    const guildsMap = new Map<string, any>();

    for (const channel of messageResults.analyzedChannels) {
      if (!channel.hasGuild || !channel.guildName) continue;

      if (!guildsMap.has(channel.guildName)) {
        guildsMap.set(channel.guildName, {
          guildName: channel.guildName,
          name: [],
          messageCount: 0,
          favoriteWordsMap: new Map<string, number>(),
          topEmojisMap: new Map<string, number>(),
          topCustomEmojisMap: new Map<string, number>(),
          topCursedMap: new Map<string, number>(),
          topLinksMap: new Map<string, number>(),
          topDiscordLinksMap: new Map<string, number>(),
          oldestMessages: [],
        });
      }

      const guild = guildsMap.get(channel.guildName);
      guild.name.push(channel.name);
      guild.messageCount += channel.messageCount;
      mergeEntriesIntoMap(channel.favoriteWords, "word", guild.favoriteWordsMap);
      mergeEntriesIntoMap(channel.topEmojis, "emoji", guild.topEmojisMap);
      mergeEntriesIntoMap(channel.topCustomEmojis, "emoji", guild.topCustomEmojisMap);
      mergeEntriesIntoMap(channel.topCursed, "word", guild.topCursedMap);
      mergeEntriesIntoMap(channel.topLinks, "word", guild.topLinksMap);
      mergeEntriesIntoMap(channel.topDiscordLinks, "word", guild.topDiscordLinksMap);

      if (channel.oldestMessages) {
        mergeOldestMessagesLimited(guild.oldestMessages, channel.oldestMessages, GUILD_OLDEST_MESSAGES_LIMIT);
      }
    }

    data.messages.topGuilds = Array.from(guildsMap.values())
      .map((guild: any) => ({
        ...guild,
        favoriteWords: mapToSortedArray(guild.favoriteWordsMap, "word", 100),
        topEmojis: mapToSortedArray(guild.topEmojisMap, "emoji", 100),
        topCustomEmojis: mapToSortedArray(guild.topCustomEmojisMap, "emoji", 100),
        topCursed: mapToSortedArray(guild.topCursedMap, "word", 100),
        topLinks: mapToSortedArray(guild.topLinksMap, "word", 100),
        topDiscordLinks: mapToSortedArray(guild.topDiscordLinksMap, "word", 100),
        oldestMessages: trimOldestMessages(guild.oldestMessages, 100),
      }))
      .sort((left: any, right: any) => right.messageCount - left.messageCount);
  }

  if (options?.messages?.characterCount) {
    data.messages.characterCount = messageResults.totalCharacterCount;
    data.messages.messageCount = messageResults.totalMessageCount;
  }

  if (options?.messages?.oldestMessages) {
    data.messages.oldestMessages = messageResults.globalOldestMessages;
  }

  if (options?.messages?.attachmentCount) {
    data.messages.attachmentCount = messageResults.globalAttachments;
    data.messages.attachmentCountTotal = messageResults.globalAttachmentTotal;
  }

  if (options?.messages?.mentionCount) {
    data.messages.mentionCount = messageResults.globalMentionCount;
  }

  if (options?.messages?.topEmojis || options?.other?.topEmojis) {
    data.messages.topEmojis = messageResults.globalTopEmojis;
  }

  if (options?.messages?.topCustomEmojis || options?.other?.topCustomEmojis) {
    data.messages.topCustomEmojis = messageResults.globalTopCustomEmojis;
  }

  if (options?.messages?.hoursValues) {
    data.messages.hoursValues = messageResults.globalHoursValues;
  }

  if (options?.other?.favoriteWords) {
    data.messages.favoriteWords = messageResults.globalFavoriteWords;
  }

  if (options?.other?.showCurseWords) {
    data.messages.topCursed = messageResults.globalTopCursed;
  }

  if (options?.other?.showLinks) {
    data.messages.topLinks = messageResults.globalTopLinks;
  }

  if (options?.other?.showDiscordLinks) {
    data.messages.topDiscordLinks = messageResults.globalTopDiscordLinks;
  }

  postSnapshot("messages", data);
  releaseEntriesByPattern(files, (file) => typeof file?.name === "string" && file.name.startsWith("Messages/"));
  for (const key of Object.keys(userMessages)) {
    delete userMessages[key];
  }

  postProgress(80, "Loading Guilds");
  if (options?.guilds) {
    data.guilds = hasServersIndex
      ? ((await readJsonEntry("Servers/index.json", files, debug)) || {})
      : {};
  }

  postSnapshot("guilds", data);
  releaseEntriesByName(files, ["Servers/index.json"]);

  postProgress(84, "Loading User Bots");
  if (options?.bots) {
    const botFiles = files.filter(
      (file: any) => file.name.startsWith("Account/applications/") && file.name.endsWith(".json")
    );

    if (botFiles.length) {
      const botEntries = await Promise.all(
        botFiles.map(async (file: any) => {
          const bot = await readJsonEntry(file.name, files, debug);
          if (!bot?.bot) return null;

          return {
            name: `${bot.bot.username}#${bot.bot.discriminator}`,
            id: bot.bot.id,
            avatar: `https://cdn.discordapp.com/avatars/${bot.bot.id}/${bot.bot.avatar}.png`,
            verified: bot.bot.public_flags === 65536,
          };
        })
      );

      data.bots = botEntries.filter(Boolean);
    }
  }

  postSnapshot("bots", data);
  releaseEntriesByPattern(
    files,
    (file) => typeof file?.name === "string" && file.name.startsWith("Account/applications/") && file.name.endsWith(".json")
  );

  postProgress(88, "Loading User Flags");
  if (userInformationData.flags && options?.user?.badges) {
    data.user.flags = userInformationData.flags;
    let badges = Array.isArray(userInformationData.flags)
      ? BitField.getBadgesFromNames(userInformationData.flags)
      : BitField.calculate(userInformationData.flags);

    if (data.user.premium_until) {
      badges.push("NITRO_UNTIL");
    } else if (userInformationData.premium_until) {
      badges.push("NITRO");
    }

    if (data?.bots?.filter((bot: any) => bot.verified)?.length > 0 && !badges.includes("VERIFIED_BOT_DEVELOPER")) {
      badges.push("VERIFIED_BOT_DEVELOPER");
    }

    data.user.badges = badges;
  }

  postSnapshot("badges", data);
  releaseEntriesByName(files, ["Account/user.json"]);
  userInformationData = null;

  if (options?.statistics?.length) {
    postProgress(92, "Loading Analytics", "Scanning analytics events");

    const analyticsFiles = files.filter((file: any) =>
      ANALYTICS_FILE_REGEX.test(file.name)
    );

    if (analyticsFiles.length) {
      const statisticsResult = await streamAnalytics(
        analyticsFiles,
        options.statistics as string[],
        (_pct, label, detail) => postProgress(95, label, detail), // eslint-disable-line no-unused-vars
      );

      data.statistics = statisticsResult;
      if (data?.statistics?.appOpened) {
        data.statistics.averageOpenCount = Utils.getAVGCount(data.statistics.appOpened, data.user.id);
      }
      if (data?.statistics?.sendMessage) {
        data.statistics.averageMessages = Utils.getAVGCount(data.statistics.sendMessage, data.user.id);
      }

      releaseEntriesByPattern(files, (file) => ANALYTICS_FILE_REGEX.test(file?.name || ""));
    }
  }

  postSnapshot("statistics", data);

  return data;
}

async function processPackage(file: File, options: any, debug: boolean) {
  postProgress(2, "Loading Package", "Reading ZIP entries");
  const files = await loadZipEntries(file);

  const requiredFiles = ["README.txt", "Account/user.json"];
  const validPackage = requiredFiles.every((requiredFile) => files.some((file) => file.name === requiredFile));
  if (!validPackage) {
    throw new Error("This package is not a valid package. Please try again.");
  }

  return extractPackageData(files, options, debug);
}

workerScope.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (event.data?.type !== "start") return;

  lastProgressAt = 0;
  lastProgressPercent = -1;

  try {
    const data = await processPackage(event.data.file, event.data.options, Boolean(event.data.debug));
    workerScope.postMessage({ type: "done", data });
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      message: toErrorMessage(error),
    });
  }
};

export {};
