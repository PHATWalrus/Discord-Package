/* eslint-disable no-mixed-spaces-and-tabs */
import { AsyncUnzipInflate, Unzip } from "fflate";
import Utils from "../utils";
import BitField from "../utils/Bitfield";

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

type WorkerChannel = {
  data_: any;
  messages: Array<any>;
  name: string;
  isDM: boolean;
  dmUserID?: string;
};

type MentionCount = {
  channel: number;
  user: number;
  role: number;
  here: number;
  everyone: number;
};

type WasmTextAnalysis = {
  favoriteWords: Array<{ word: string; count: number }>;
  topLinks: Array<{ word: string; count: number }>;
  topDiscordLinks: Array<{ word: string; count: number }>;
  topEmojis: Array<{ emoji: string; count: number }>;
  topCustomEmojis: Array<{ emoji: string; count: number }>;
  mentionCount: MentionCount;
};

// eslint-disable-next-line no-unused-vars
type WasmAnalyzeText = (input: string) => WasmTextAnalysis | null;

const workerScope: any = self;

const EMOJI_REGEX = /\ud83c[\udf00-\udfff]|\ud83d[\udc00-\ude4f]|\ud83d[\ude80-\udeff]/g;
const CUSTOM_EMOJI_REGEX = /<a?:[a-zA-Z0-9_]+:(\d+)>/g;
const ATTACHMENT_REGEX = /(https?:\/\/.*\.(?:png|jpg|jpeg|gif|mp4|pdf|zip|wmv|mp3|nitf|doc|docx))/gi;
const TENOR_GIF_REGEX = /https?:\/\/(c\.tenor\.com\/([^ /\n]+)\/([^ /\n]+)\.gif|tenor\.com\/view\/(?:.*-)?([^ /\n]+))/gi;
const CHANNEL_MENTION_REGEX = /<#[0-9]*>/gi;
const USER_MENTION_REGEX = /<@[0-9]*>/gi;
const ROLE_MENTION_REGEX = /<@&[0-9]*>/gi;
const MESSAGES_REGEX = /Messages\/(c)?([0-9]{16,32})\/channel\.json$/;
const ANALYTICS_FILE_REGEX = /Activity\/analytics\/events-[0-9]{4}-[0-9]{5}-of-[0-9]{5}\.json$/;
const GLOBAL_OLDEST_MESSAGES_LIMIT = 1000;
const GUILD_OLDEST_MESSAGES_LIMIT = 100;
const ATTACHMENT_PREVIEW_LIMIT = 1000;

let lastProgressAt = 0;
let lastProgressPercent = -1;
let wasmAnalyzeText: WasmAnalyzeText | null = null;
let wasmInitPromise: Promise<void> | null = null;

function resolveWasmAssetUrl(assetName: string) {
  const { origin, pathname } = workerScope.location;
  const nextIndex = pathname.indexOf("/_next/");
  const basePath = nextIndex >= 0 ? pathname.slice(0, nextIndex) : "";
  const normalizedBasePath = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;

  return new URL(`${normalizedBasePath}/wasm/${assetName}`, origin).toString();
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
  workerScope.postMessage({
    type: "snapshot",
    stage,
    data,
  });
}

function postProgress(percent: number, label: string, detail: string = "") {
  const now = Date.now();
  if (percent === lastProgressPercent && now - lastProgressAt < 250) {
    return;
  }

  lastProgressAt = now;
  lastProgressPercent = percent;
  workerScope.postMessage({
    type: "progress",
    percent,
    label,
    detail,
  });
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown package processing error";
}

async function ensureWasmAnalyzer() {
  if (wasmAnalyzeText) {
    return;
  }

  if (wasmInitPromise) {
    return wasmInitPromise;
  }

  wasmInitPromise = (async () => {
    try {
      const moduleUrl = resolveWasmAssetUrl("discord_package_wasm.js");
      const wasmUrl = resolveWasmAssetUrl("discord_package_wasm_bg.wasm");
      const wasmModule: any = await import(
        /* webpackIgnore: true */ moduleUrl
      );

      await wasmModule.default(wasmUrl);
      wasmAnalyzeText = (text: string) => {
        if (!text) {
          return null;
        }

        const result = wasmModule.analyze_text(text);
        return result ? JSON.parse(result) as WasmTextAnalysis : null;
      };
    } catch {
      wasmAnalyzeText = null;
    }
  })();

  try {
    await wasmInitPromise;
  } finally {
    wasmInitPromise = null;
  }
}

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
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
    .sort(
      (left, right) =>
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

async function loadZipEntries(file: Blob) {
  const files: Array<any> = [];
  const reader = new Unzip();
  reader.register(AsyncUnzipInflate);
  reader.onfile = (file) => {
    files.push(file);
  };

  if (typeof file.stream === "function") {
    const fileReader = file.stream().getReader();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const chunk = await fileReader.read();
      if (chunk.done) {
        reader.push(new Uint8Array(0), true);
        break;
      }

      const value = chunk.value;
      if (!value?.length) {
        continue;
      }

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

function getEmojiEntriesFromText(text: string) {
  const emojiMap = new Map<string, number>();
  const emojiChars = text.match(EMOJI_REGEX) || [];
  for (const emoji of emojiChars) {
    incrementMap(emojiMap, emoji);
  }
  return mapToSortedArray(emojiMap, "emoji", 1000);
}

function getCustomEmojiEntriesFromText(text: string) {
  const emojiMap = new Map<string, number>();
  const emojiChars = text.toLowerCase().match(CUSTOM_EMOJI_REGEX) || [];
  for (const emoji of emojiChars) {
    incrementMap(emojiMap, emoji);
  }
  return mapToSortedArray(emojiMap, "emoji", 1000);
}

function getAttachmentMatches(words: string[]) {
  const attachments: string[] = [];

  for (const word of words) {
    if (!word) continue;
    ATTACHMENT_REGEX.lastIndex = 0;
    TENOR_GIF_REGEX.lastIndex = 0;
    if (!ATTACHMENT_REGEX.test(word) && !TENOR_GIF_REGEX.test(word)) {
      continue;
    }

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

  return attachments;
}

function getMentionCountsFromText(text: string): MentionCount {
  return {
    channel: (text.match(CHANNEL_MENTION_REGEX) || []).length,
    user: (text.match(USER_MENTION_REGEX) || []).length,
    role: (text.match(ROLE_MENTION_REGEX) || []).length,
    here: (text.match(/@here/g) || []).length,
    everyone: (text.match(/@everyone/g) || []).length,
  };
}

function analyzeTextContent(joinedText: string, options: any) {
  const wasmResult = wasmAnalyzeText ? wasmAnalyzeText(joinedText) : null;
  let splitWords: string[] | null = null;

  const getWords = () => {
    if (!splitWords) {
      splitWords = joinedText.split(/\s+/).filter(Boolean);
    }

    return splitWords;
  };

  return {
    favoriteWords: options?.other?.favoriteWords
      ? wasmResult?.favoriteWords || Utils.getFavoriteWords(getWords())
      : null,
    topCursed: options?.other?.showCurseWords
      ? Utils.getCursedWords(
        getWords().filter((word: string) => word.length < 10 && !/[^\w\s]/g.test(word))
      )
      : null,
    topLinks: options?.other?.showLinks
      ? wasmResult?.topLinks || Utils.getTopLinks(getWords())
      : null,
    topDiscordLinks: options?.other?.showDiscordLinks
      ? wasmResult?.topDiscordLinks || Utils.getDiscordLinks(getWords())
      : null,
    topEmojis: options?.messages?.topEmojis || options?.other?.topEmojis
      ? wasmResult?.topEmojis || getEmojiEntriesFromText(joinedText)
      : null,
    topCustomEmojis: options?.messages?.topCustomEmojis || options?.other?.topCustomEmojis
      ? wasmResult?.topCustomEmojis || getCustomEmojiEntriesFromText(joinedText)
      : null,
    mentionCount: options?.messages?.mentionCount
      ? wasmResult?.mentionCount || getMentionCountsFromText(joinedText)
      : { channel: 0, user: 0, role: 0, here: 0, everyone: 0 },
  };
}

function buildAuthor(channel: WorkerChannel) {
  if (channel.data_ && channel.data_?.guild) {
    return `channel: ${channel.name} (guild: ${channel.data_.guild.name})`;
  }

  if (channel.isDM && channel.name.includes("Direct Message with")) {
    return `user: ${channel.name.split("Direct Message with")[1].trim()} (id: ${channel.dmUserID})`;
  }

  return "Unknown";
}

function analyzeChannel(channel: WorkerChannel, options: any) {
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
  const author = buildAuthor(channel);
  const shouldCollectOldest = options?.other?.oldestMessages || options?.messages?.oldestMessages;

  for (const message of channel.messages) {
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
      const oldestMessage: any = {
        sentence: words.join(" "),
        timestamp: message.timestamp,
      };
      if (author !== "Unknown") {
        oldestMessage.author = author;
      }
      oldestMessages.push(oldestMessage);
    }

    if (options?.messages?.attachmentCount) {
      attachments.push(...getAttachmentMatches(words));
    }
  }

  const joinedText = joinedParts.join(" ");
  const textAnalysis = analyzeTextContent(joinedText, options);
  const favoriteWordsAll = textAnalysis.favoriteWords;
  const cursedWordsAll = textAnalysis.topCursed;
  const topLinksAll = textAnalysis.topLinks;
  const topDiscordLinksAll = textAnalysis.topDiscordLinks;
  const topEmojis = textAnalysis.topEmojis;
  const topCustomEmojis = textAnalysis.topCustomEmojis;
  const mentionCount = textAnalysis.mentionCount;

  return {
    name: channel.name,
    messageCount: channel.messages.length,
    guildName: channel.data_?.guild?.name,
    favoriteWords: favoriteWordsAll?.slice(0, 1000) || null,
    topCursed: cursedWordsAll?.slice(0, 1000) || null,
    topLinks: topLinksAll?.slice(0, 1000) || null,
    topDiscordLinks: topDiscordLinksAll?.slice(0, 1000) || null,
    oldestMessages: shouldCollectOldest
      ? trimOldestMessages(oldestMessages, 100)
      : null,
    topEmojis,
    topCustomEmojis,
    channel_id: channel.data_?.id,
    user_id: channel.dmUserID,
    user_tag: channel.isDM && channel.name.includes("Direct Message with")
      ? channel.name.split("Direct Message with")[1].trim()
      : null,
    recipients: channel.data_?.recipients?.length,
    isDM: channel.isDM,
    isGroupDM: !channel.data_?.guild && !channel.isDM && channel.data_?.recipients?.length > 1 && !channel.dmUserID,
    hasGuild: !!channel.data_?.guild,
    characterCount,
    attachments,
    mentionCount,
    hoursValues,
    aggregateFavoriteWords: favoriteWordsAll,
    aggregateTopCursed: cursedWordsAll,
    aggregateTopLinks: topLinksAll,
    aggregateTopDiscordLinks: topDiscordLinksAll,
  };
}

async function buildChannels(files: Array<any>, userMessages: Record<string, string>, userId: string, hasMessagesIndex: boolean, debug: boolean, options: any) {
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

  const analyzedChannels: Array<any> = [];
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

  const batches = chunkArray(channelsIDs, 25);
  for (const batch of batches) {
    const batchChannels = await Promise.all(
      batch.map(async (channelID) => {
        const channelDataPath = `Messages/${isOldPackage ? "" : "c"}${channelID}/channel.json`;
        const channelMessagesPath = `Messages/${isOldPackage ? "" : "c"}${channelID}/messages.${extension}`;

        try {
          const [rawData, rawMessages] = await Promise.all([
            readEntry(channelDataPath, files, debug),
            readEntry(channelMessagesPath, files, debug),
          ]);

          if (!rawData || !rawMessages) {
            return null;
          }

          const data_ = JSON.parse(rawData);
          const messages = extension === "csv"
            ? Utils.parseCSV(rawMessages)
            : Utils.parseJSON(rawMessages, { entryName: channelMessagesPath });
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

          return {
            data_,
            messages,
            name,
            isDM,
            dmUserID,
          } satisfies WorkerChannel;
        } catch {
          return null;
        }
      })
    );

    for (const channel of batchChannels) {
      if (!channel) continue;
      messagesRead++;
      const analyzed = analyzeChannel(channel, options);
      totalMessageCount += analyzed.messageCount;
      totalCharacterCount += analyzed.characterCount || 0;

      mergeEntriesIntoMap(analyzed.aggregateFavoriteWords, "word", globalFavoriteWordsMap);
      mergeEntriesIntoMap(analyzed.aggregateTopCursed, "word", globalTopCursedMap);
      mergeEntriesIntoMap(analyzed.aggregateTopLinks, "word", globalTopLinksMap);
      mergeEntriesIntoMap(analyzed.aggregateTopDiscordLinks, "word", globalTopDiscordLinksMap);
      mergeEntriesIntoMap(analyzed.topEmojis, "emoji", globalTopEmojisMap);
      mergeEntriesIntoMap(analyzed.topCustomEmojis, "emoji", globalTopCustomEmojisMap);

      if (analyzed.oldestMessages) {
        mergeOldestMessagesLimited(globalOldestMessages, analyzed.oldestMessages, GLOBAL_OLDEST_MESSAGES_LIMIT);
      }

      if (analyzed.attachments?.length) {
        globalAttachmentTotal += analyzed.attachments.length;
        appendAttachmentPreview(globalAttachments, analyzed.attachments, ATTACHMENT_PREVIEW_LIMIT);
      }

      if (analyzed.mentionCount) {
        globalMentionCount.channel += analyzed.mentionCount.channel;
        globalMentionCount.user += analyzed.mentionCount.user;
        globalMentionCount.role += analyzed.mentionCount.role;
        globalMentionCount.here += analyzed.mentionCount.here;
        globalMentionCount.everyone += analyzed.mentionCount.everyone;
      }

      if (analyzed.hoursValues) {
        analyzed.hoursValues.hourly.forEach((count: number, index: number) => {
          globalHoursValues.hourly[index] += count;
        });
        analyzed.hoursValues.daily.forEach((count: number, index: number) => {
          globalHoursValues.daily[index] += count;
        });
        analyzed.hoursValues.monthly.forEach((count: number, index: number) => {
          globalHoursValues.monthly[index] += count;
        });
        Object.entries(analyzed.hoursValues.yearly || {}).forEach(([year, count]) => {
          globalHoursValues.yearly.set(year, (globalHoursValues.yearly.get(year) || 0) + Number(count));
        });
      }

      analyzedChannels.push({
        name: analyzed.name,
        messageCount: analyzed.messageCount,
        guildName: analyzed.guildName,
        favoriteWords: analyzed.favoriteWords,
        topCursed: analyzed.topCursed,
        topLinks: analyzed.topLinks,
        topDiscordLinks: analyzed.topDiscordLinks,
        oldestMessages: analyzed.oldestMessages,
        topEmojis: analyzed.topEmojis,
        topCustomEmojis: analyzed.topCustomEmojis,
        channel_id: analyzed.channel_id,
        user_id: analyzed.user_id,
        user_tag: analyzed.user_tag,
        recipients: analyzed.recipients,
        isDM: analyzed.isDM,
        isGroupDM: analyzed.isGroupDM,
        hasGuild: analyzed.hasGuild,
        characterCount: analyzed.characterCount,
      });
    }

    processedChannels += batch.length;
    const progress = Math.min(75, 30 + Math.round((processedChannels / channelsIDs.length) * 45));
    postProgress(progress, "Loading Messages", `${Math.min(processedChannels, channelsIDs.length)}/${channelsIDs.length} channels processed`);
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

async function extractPackageData(files: Array<any>, options: any, debug: boolean) {
  const data: any = createEmptyPackageData();

  postProgress(5, "Loading User Information");
  const userInformationData = await readJsonEntry("Account/user.json", files, debug);
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

  postProgress(25, "Loading Messages", "Preparing channel scan");

  const hasMessagesIndex = files.some((file: any) => file.name === "Messages/index.json");
  const hasServersIndex = files.some((file: any) => file.name === "Servers/index.json");
  let userMessages: Record<string, string> = {};

  if (hasMessagesIndex) {
    userMessages = (await readJsonEntry("Messages/index.json", files, debug)) || {};
  }

  const messageResults = await buildChannels(files, userMessages, data.user.id, hasMessagesIndex, debug, options);

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

  if (options?.statistics?.length) {
    postProgress(92, "Loading Analytics", "Scanning analytics events");
    const analyticsFiles = files.filter((file: any) =>
      ANALYTICS_FILE_REGEX.test(file.name)
    );
    const statistics = await Utils.readAnalyticsFiles(
      analyticsFiles,
      null,
      (value: string) => {
        const [label = value, detail = ""] = String(value).split("|||");
        postProgress(95, label, detail);
      },
      options.statistics
    );

    data.statistics = statistics?.all;
    if (data?.statistics?.appOpened) {
      data.statistics.averageOpenCount = Utils.getAVGCount(data.statistics.appOpened, data.user.id);
    }
    if (data?.statistics?.sendMessage) {
      data.statistics.averageMessages = Utils.getAVGCount(data.statistics.sendMessage, data.user.id);
    }

    releaseEntriesByPattern(files, (file) => ANALYTICS_FILE_REGEX.test(file?.name || ""));
  }

  postSnapshot("statistics", data);

  return data;
}

async function processPackage(file: File, options: any, debug: boolean) {
  postProgress(2, "Loading Package", "Reading ZIP entries");
  const [files] = await Promise.all([loadZipEntries(file), ensureWasmAnalyzer()]);

  const requiredFiles = ["README.txt", "Account/user.json"];
  const validPackage = requiredFiles.every((requiredFile) => files.some((file) => file.name === requiredFile));
  if (!validPackage) {
    throw new Error("This package is not a valid package. Please try again.");
  }

  return extractPackageData(files, options, debug);
}

workerScope.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (event.data?.type !== "start") {
    return;
  }

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