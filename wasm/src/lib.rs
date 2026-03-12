use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

fn to_snake_case(input: &str) -> String {
    let mut output = String::with_capacity(input.len() + 8);
    let mut previous_was_lowercase = false;

    for ch in input.chars() {
        if ch.is_ascii_uppercase() {
            if previous_was_lowercase {
                output.push('_');
            }
            output.push(ch.to_ascii_lowercase());
            previous_was_lowercase = false;
            continue;
        }

        if ch == ' ' || ch == '-' {
            if !output.ends_with('_') {
                output.push('_');
            }
            previous_was_lowercase = false;
            continue;
        }

        output.push(ch);
        previous_was_lowercase = ch.is_ascii_lowercase() || ch.is_ascii_digit();
    }

    output
}

fn scan_analytics_counts(text: &str, event_names: &[String]) -> HashMap<String, u32> {
    let mut counts = HashMap::with_capacity(event_names.len());
    if text.is_empty() || event_names.is_empty() {
        for event_name in event_names {
            counts.insert(event_name.clone(), 0);
        }
        return counts;
    }

    let bytes = text.as_bytes();
    let mut patterns: Vec<(String, Vec<u8>)> = Vec::with_capacity(event_names.len());
    let mut patterns_by_first_byte: HashMap<u8, Vec<usize>> = HashMap::new();

    for event_name in event_names {
        let snake_name = to_snake_case(event_name);
        let pattern_bytes = snake_name.as_bytes().to_vec();
        counts.insert(event_name.clone(), 0);

        if let Some(first_byte) = pattern_bytes.first().copied() {
            patterns_by_first_byte
                .entry(first_byte)
                .or_default()
                .push(patterns.len());
        }

        patterns.push((event_name.clone(), pattern_bytes));
    }

    for index in 0..bytes.len() {
        let Some(candidate_indexes) = patterns_by_first_byte.get(&bytes[index]) else {
            continue;
        };

        for candidate_index in candidate_indexes {
            let (event_name, pattern) = &patterns[*candidate_index];
            let end_index = index + pattern.len();
            if end_index > bytes.len() {
                continue;
            }

            if &bytes[index..end_index] == pattern.as_slice() {
                if let Some(count) = counts.get_mut(event_name) {
                    *count += 1;
                }
            }
        }
    }

    counts
}

static CUSTOM_EMOJI_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)<a?:[a-zA-Z0-9_]+:\d+>").unwrap());
static URL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\b(?:https?|ftp|file)://[-A-Z0-9+&@#/%?=~_|!:,.;]*[-A-Z0-9+&@#/%=~_|]")
        .unwrap()
});
static DISCORD_INVITE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)(https://)?(www\.)?(discord\.gg|discord\.me|discordapp\.com/invite|discord\.com/invite)/([a-z0-9-.]+)?",
    )
    .unwrap()
});
static CHANNEL_MENTION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<#[0-9]*>").unwrap());
static USER_MENTION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<@[0-9]*>").unwrap());
static ROLE_MENTION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<@&[0-9]*>").unwrap());
static ATTACHMENT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)(https?://.*\.(?:png|jpg|jpeg|gif|mp4|pdf|zip|wmv|mp3|nitf|doc|docx))")
        .unwrap()
});
static TENOR_GIF_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)https?://(c\.tenor\.com/[^ /\n]+/[^ /\n]+\.gif|tenor\.com/view/(?:.*-)?[^ /\n]+)")
        .unwrap()
});

// Single compiled regex for curse word extraction with counts
static CURSE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)(?:\b(?:4r5e|5h1t|5hit|a55|a_s_s|anal|anus|ar5e|arrse|arse|ass|ass-fucker|asses|assfucker|assfukka|asshole|assholes|asswhole|b00bs|b17ch|b1tch|ballbag|balls|ballsack|bastard|beastial|beastiality|bellend|bestial|bestiality|biatch|bitch|bitcher|bitchers|bitches|bitchin|bitching|bloody|blowjob|blowjobs|boiolas|bollock|bollok|boner|boob|boobs|booobs|boooobs|booooobs|booooooobs|breasts|buceta|bugger|bum|butt|butthole|buttmuch|buttplug|c0ck|c0cksucker|cawk|chink|cipa|cl1t|clit|clitoris|clits|cnut|cock|cock-sucker|cockface|cockhead|cockmunch|cockmuncher|cocks|cocksuck|cocksucked|cocksucker|cocksucking|cocksucks|cocksuka|cocksukka|cok|cokmuncher|coksucka|coon|cox|crap|cum|cummer|cumming|cums|cumshot|cunilingus|cunillingus|cunnilingus|cunt|cuntlick|cuntlicker|cuntlicking|cunts|cyalis|cyberfuc|cyberfuck|cyberfucked|cyberfucker|cyberfuckers|cyberfucking|d1ck|damn|dick|dickhead|dildo|dildos|dink|dinks|dirsa|dlck|dog-fucker|doggin|dogging|donkeyribber|doosh|duche|dyke|ejaculate|ejaculated|ejaculates|ejaculating|ejaculatings|ejaculation|ejakulate|f4nny|f_u_c_k|fag|fagging|faggitt|faggot|faggs|fagot|fagots|fags|fanny|fannyflaps|fannyfucker|fanyy|fatass|fcuk|fcuker|fcuking|feck|fecker|felching|fellate|fellatio|fingerfuck|fingerfucked|fingerfucker|fingerfuckers|fingerfucking|fingerfucks|fistfuck|fistfucked|fistfucker|fistfuckers|fistfucking|fistfuckings|fistfucks|flange|fook|fooker|fuck|fucka|fucked|fucker|fuckers|fuckhead|fuckheads|fuckin|fucking|fuckings|fuckingshitmotherfucker|fuckme|fucks|fuckwhit|fuckwit|fudgepacker|fuk|fuker|fukker|fukkin|fuks|fukwhit|fukwit|fux|fux0r|gangbang|gangbanged|gangbangs|gaylord|gaysex|goatse|god|god-dam|god-damned|goddamn|goddamned|hardcoresex|hell|heshe|hoar|hoare|hoer|homo|hore|horniest|horny|hotsex|jack-off|jackoff|jap|jerk-off|jism|jiz|jizm|jizz|kawk|knob|knobead|knobed|knobend|knobhead|knobjocky|knobjokey|kock|kondum|kondums|kum|kummer|kumming|kums|kunilingus|l3itch|labia|lust|lusting|m0f0|m0fo|m45terbate|ma5terb8|ma5terbate|masochist|master-bate|masterb8|masterbat3|masterbate|masterbation|masterbations|masturbate|mo-fo|mof0|mofo|mothafuck|mothafucka|mothafuckas|mothafuckaz|mothafucked|mothafucker|mothafuckers|mothafuckin|mothafucking|mothafuckings|mothafucks|motherfuck|motherfucked|motherfucker|motherfuckers|motherfuckin|motherfucking|motherfuckings|motherfuckka|motherfucks|muff|mutha|muthafecker|muthafuckker|muther|mutherfucker|n1gga|n1gger|nazi|nigg3r|nigg4h|nigga|niggah|niggas|niggaz|nigger|niggers|nob|nobhead|nobjocky|nobjokey|numbnuts|nutsack|orgasim|orgasims|orgasm|orgasms|p0rn|pawn|pecker|penis|penisfucker|phonesex|phuck|phuk|phuked|phuking|phukked|phukking|phuks|phuq|pigfucker|pimpis|piss|pissed|pisser|pissers|pisses|pissflaps|pissin|pissing|pissoff|poop|porn|porno|pornography|pornos|prick|pricks|pron|pube|pusse|pussi|pussies|pussy|pussys|rectum|retard|rimjaw|rimming|s_h_i_t|sadist|schlong|screwing|scroat|scrote|scrotum|semen|sex|sh1t|shag|shagger|shaggin|shagging|shemale|shit|shitdick|shite|shited|shitey|shitfuck|shitfull|shithead|shiting|shitings|shits|shitted|shitter|shitters|shitting|shittings|shitty|skank|slut|sluts|smegma|smut|snatch|son-of-a-bitch|spac|spunk|t1tt1e5|t1tties|teets|teez|testical|testicle|tit|titfuck|tits|titt|tittie5|tittiefucker|titties|tittyfuck|tittywank|titwank|tosser|turd|tw4t|twat|twathead|twatty|twunt|twunter|v14gra|v1gra|vagina|viagra|vulva|w00se|wang|wank|wanker|wanky|whoar|whore|willies|willy|xrated|xxx)\b|b!tch|bi\+ch|blow\ job|bunny\ fucker|carpet\ muncher|f\ u\ c\ k|f\ u\ c\ k\ e\ r|fudge\ packer|l3i\+ch|masterbat\*|mother\ fucker|nob\ jokey|s\ hit|s\.o\.b\.|sh!\+|sh!t|shi\+)"#).unwrap()
});

#[derive(Serialize)]
struct CountEntry {
    word: String,
    count: u32,
}

#[derive(Serialize)]
struct EmojiEntry {
    emoji: String,
    count: u32,
}

#[derive(Serialize, Default)]
struct MentionCount {
    channel: u32,
    user: u32,
    role: u32,
    here: u32,
    everyone: u32,
}

#[derive(Serialize, Default)]
struct AnalysisResult {
    #[serde(rename = "favoriteWords")]
    favorite_words: Vec<CountEntry>,
    #[serde(rename = "topLinks")]
    top_links: Vec<CountEntry>,
    #[serde(rename = "topDiscordLinks")]
    top_discord_links: Vec<CountEntry>,
    #[serde(rename = "topEmojis")]
    top_emojis: Vec<EmojiEntry>,
    #[serde(rename = "topCustomEmojis")]
    top_custom_emojis: Vec<EmojiEntry>,
    #[serde(rename = "mentionCount")]
    mention_count: MentionCount,
}

#[derive(Serialize, Default)]
struct HoursValues {
    hourly: Vec<u32>,
    daily: Vec<u32>,
    monthly: Vec<u32>,
    yearly: HashMap<String, u32>,
}

#[derive(Serialize)]
struct OldestMessage {
    sentence: String,
    timestamp: String,
}

#[derive(Serialize, Default)]
struct ChannelAnalysis {
    #[serde(rename = "messageCount")]
    message_count: u32,
    #[serde(rename = "characterCount")]
    character_count: u32,
    #[serde(rename = "favoriteWords")]
    favorite_words: Vec<CountEntry>,
    #[serde(rename = "topCursed")]
    top_cursed: Vec<CountEntry>,
    #[serde(rename = "topLinks")]
    top_links: Vec<CountEntry>,
    #[serde(rename = "topDiscordLinks")]
    top_discord_links: Vec<CountEntry>,
    #[serde(rename = "topEmojis")]
    top_emojis: Vec<EmojiEntry>,
    #[serde(rename = "topCustomEmojis")]
    top_custom_emojis: Vec<EmojiEntry>,
    #[serde(rename = "mentionCount")]
    mention_count: MentionCount,
    #[serde(rename = "hoursValues")]
    hours_values: HoursValues,
    #[serde(rename = "oldestMessages")]
    oldest_messages: Vec<OldestMessage>,
    attachments: Vec<String>,
}

// Minimal shape we need from each message JSON object
#[derive(Deserialize)]
struct RawMessage {
    #[serde(alias = "Contents")]
    contents: Option<String>,
    #[serde(alias = "Timestamp")]
    timestamp: Option<String>,
}

fn push_count(target: &mut HashMap<String, u32>, key: &str) {
    let entry = target.entry(key.to_owned()).or_insert(0);
    *entry += 1;
}

fn to_word_entries(target: HashMap<String, u32>, limit: usize) -> Vec<CountEntry> {
    let mut items: Vec<CountEntry> = target
        .into_iter()
        .map(|(word, count)| CountEntry { word, count })
        .collect();

    items.sort_by(|left, right| right.count.cmp(&left.count));
    items.truncate(limit);
    items
}

fn to_emoji_entries(target: HashMap<String, u32>, limit: usize) -> Vec<EmojiEntry> {
    let mut items: Vec<EmojiEntry> = target
        .into_iter()
        .map(|(emoji, count)| EmojiEntry { emoji, count })
        .collect();

    items.sort_by(|left, right| right.count.cmp(&left.count));
    items.truncate(limit);
    items
}

fn is_supported_emoji(character: char) -> bool {
    let codepoint = character as u32;

    (0x1F300..=0x1F5FF).contains(&codepoint)
        || (0x1F600..=0x1F64F).contains(&codepoint)
        || (0x1F680..=0x1F6FF).contains(&codepoint)
}

/// Parse a simple ISO 8601 timestamp to extract date components.
/// Returns (year, month 0-11, day_of_week 0=Sun..6=Sat, hour 0-23) or None.
fn parse_timestamp(ts: &str) -> Option<(i32, u32, u32, u32)> {
    // Format: "2023-01-15T14:30:00.000+00:00" or similar
    if ts.len() < 16 {
        return None;
    }
    let year: i32 = ts.get(0..4)?.parse().ok()?;
    let month: u32 = ts.get(5..7)?.parse::<u32>().ok()?.checked_sub(1)?; // 0-indexed
    let day: u32 = ts.get(8..10)?.parse().ok()?;
    let hour: u32 = ts.get(11..13)?.parse().ok()?;

    if month > 11 || day < 1 || day > 31 || hour > 23 {
        return None;
    }

    // Zeller-like day of week (0=Sunday)
    let dow = day_of_week(year, month + 1, day);
    Some((year, month, dow, hour))
}

/// Compute day of week (0=Sunday) using Tomohiko Sakamoto's algorithm
fn day_of_week(year: i32, month: u32, day: u32) -> u32 {
    static T: [i32; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if month < 3 { year - 1 } else { year };
    let dow = (y + y / 4 - y / 100 + y / 400 + T[month as usize - 1] + day as i32) % 7;
    if dow < 0 { (dow + 7) as u32 } else { dow as u32 }
}

/// Escape literal newlines inside "Contents" values to keep JSON parseable
fn escape_newlines_in_contents(input: &str) -> String {
    // Fast path: if no newlines at all, return as-is
    if !input.contains('\n') && !input.contains('\r') {
        return input.to_string();
    }

    let re = Regex::new(r###"("Contents"\s*:\s*")((?:\\.|[^"\\])*)(")"###).unwrap();
    re.replace_all(input, |caps: &regex::Captures| {
        let prefix = &caps[1];
        let body = &caps[2];
        let suffix = &caps[3];
        if !body.contains('\n') && !body.contains('\r') {
            return caps[0].to_string();
        }
        format!("{}{}{}", prefix, body.replace("\r\n", "\\n").replace('\n', "\\n").replace('\r', "\\n"), suffix)
    }).into_owned()
}

/// Try to parse messages from JSON text, handling various Discord export formats
fn parse_json_messages(input: &str) -> Vec<RawMessage> {
    let cleaned = escape_newlines_in_contents(input);

    // Try direct parse as array
    if let Ok(messages) = serde_json::from_str::<Vec<RawMessage>>(&cleaned) {
        return messages;
    }

    // Try as { messages: [...] } wrapper
    #[derive(Deserialize)]
    struct Wrapper {
        messages: Vec<RawMessage>,
    }
    if let Ok(wrapper) = serde_json::from_str::<Wrapper>(&cleaned) {
        return wrapper.messages;
    }

    // Fallback: try to salvage individual JSON objects
    let mut messages = Vec::new();
    let mut depth = 0i32;
    let mut start = None;
    let mut in_string = false;
    let mut escape_next = false;

    for (i, ch) in cleaned.char_indices() {
        if escape_next {
            escape_next = false;
            continue;
        }
        if ch == '\\' && in_string {
            escape_next = true;
            continue;
        }
        if ch == '"' {
            in_string = !in_string;
            continue;
        }
        if in_string {
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start = Some(i);
            }
            depth += 1;
        } else if ch == '}' {
            depth -= 1;
            if depth == 0 {
                if let Some(s) = start {
                    if let Ok(msg) = serde_json::from_str::<RawMessage>(&cleaned[s..=i]) {
                        messages.push(msg);
                    }
                }
                start = None;
            }
        }
    }

    messages
}

/// Parse CSV messages (Discord format: ID,Timestamp,Contents with ",\r" newline)
fn parse_csv_messages(input: &str) -> Vec<RawMessage> {
    let mut messages = Vec::new();
    let lines: Vec<&str> = input.split(",\r").collect();

    // Skip header row
    for line in lines.iter().skip(1) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Split on first two commas: ID,Timestamp,Contents...
        let mut parts = line.splitn(3, ',');
        let _id = parts.next();
        let timestamp = parts.next().map(|s| s.to_string());
        let contents = parts.next().map(|s| s.to_string());

        if contents.as_ref().map_or(true, |c| c.is_empty()) {
            continue;
        }

        messages.push(RawMessage {
            contents,
            timestamp,
        });
    }

    messages
}

/// Options bitmask for what to compute
/// Bit 0: favoriteWords
/// Bit 1: topCursed
/// Bit 2: topLinks
/// Bit 3: topDiscordLinks
/// Bit 4: topEmojis
/// Bit 5: topCustomEmojis
/// Bit 6: mentionCount
/// Bit 7: hoursValues
/// Bit 8: oldestMessages
/// Bit 9: attachmentCount
/// Bit 10: characterCount
const OPT_FAVORITE_WORDS: u32 = 1 << 0;
const OPT_CURSED: u32 = 1 << 1;
const OPT_LINKS: u32 = 1 << 2;
const OPT_DISCORD_LINKS: u32 = 1 << 3;
const OPT_EMOJIS: u32 = 1 << 4;
const OPT_CUSTOM_EMOJIS: u32 = 1 << 5;
const OPT_MENTIONS: u32 = 1 << 6;
const OPT_HOURS: u32 = 1 << 7;
const OPT_OLDEST: u32 = 1 << 8;
const OPT_ATTACHMENTS: u32 = 1 << 9;
const OPT_CHAR_COUNT: u32 = 1 << 10;

/// Analyze channel messages from raw text.
/// `format`: 0 = JSON, 1 = CSV
/// `options`: bitmask of what to compute
#[wasm_bindgen]
pub fn analyze_channel_messages(raw: &str, format: u32, options: u32) -> String {
    let messages = if format == 1 {
        parse_csv_messages(raw)
    } else {
        parse_json_messages(raw)
    };

    let mut favorite_words: HashMap<String, u32> = HashMap::new();
    let mut cursed_words: HashMap<String, u32> = HashMap::new();
    let mut links: HashMap<String, u32> = HashMap::new();
    let mut discord_links: HashMap<String, u32> = HashMap::new();
    let mut emojis: HashMap<String, u32> = HashMap::new();
    let mut custom_emojis: HashMap<String, u32> = HashMap::new();
    let mut mention_count = MentionCount::default();
    let mut hours_values = HoursValues {
        hourly: vec![0u32; 24],
        daily: vec![0u32; 7],
        monthly: vec![0u32; 12],
        yearly: HashMap::new(),
    };
    let mut oldest_messages: Vec<OldestMessage> = Vec::new();
    let mut attachments: Vec<String> = Vec::new();
    let mut character_count: u32 = 0;
    let mut message_count: u32 = 0;

    let want_words = options & OPT_FAVORITE_WORDS != 0;
    let want_cursed = options & OPT_CURSED != 0;
    let want_links = options & OPT_LINKS != 0;
    let want_discord_links = options & OPT_DISCORD_LINKS != 0;
    let want_emojis = options & OPT_EMOJIS != 0;
    let want_custom_emojis = options & OPT_CUSTOM_EMOJIS != 0;
    let want_mentions = options & OPT_MENTIONS != 0;
    let want_hours = options & OPT_HOURS != 0;
    let want_oldest = options & OPT_OLDEST != 0;
    let want_attachments = options & OPT_ATTACHMENTS != 0;
    let want_char_count = options & OPT_CHAR_COUNT != 0;

    for msg in &messages {
        let contents = match &msg.contents {
            Some(c) if !c.is_empty() => c.as_str(),
            _ => continue,
        };

        message_count += 1;

        if want_char_count {
            character_count += contents.len() as u32;
        }

        // Timestamp analysis
        if want_hours || want_oldest {
            if let Some(ts) = &msg.timestamp {
                if want_hours {
                    if let Some((year, month, dow, hour)) = parse_timestamp(ts) {
                        hours_values.hourly[hour as usize] += 1;
                        hours_values.daily[dow as usize] += 1;
                        hours_values.monthly[month as usize] += 1;
                        let year_str = year.to_string();
                        *hours_values.yearly.entry(year_str).or_insert(0) += 1;
                    }
                }

                if want_oldest {
                    oldest_messages.push(OldestMessage {
                        sentence: contents.to_string(),
                        timestamp: ts.clone(),
                    });
                }
            }
        }

        // Word-level analysis
        if want_words || want_links || want_discord_links || want_attachments {
            for token in contents.split_whitespace() {
                if want_words && token.chars().count() > 3 {
                    push_count(&mut favorite_words, token);
                }

                if want_links {
                    if let Some(found) = URL_RE.find(token) {
                        let url = found.as_str();
                        if url.len() > 3 {
                            push_count(&mut links, url);
                        }
                    }
                }

                if want_discord_links {
                    if let Some(found) = DISCORD_INVITE_RE.find(token) {
                        let invite = found.as_str();
                        if invite.len() > 15 {
                            push_count(&mut discord_links, invite);
                        }
                    }
                }

                if want_attachments {
                    let is_attachment = ATTACHMENT_RE.is_match(token) || TENOR_GIF_RE.is_match(token);
                    if is_attachment {
                        let matched = ATTACHMENT_RE.find(token)
                            .or_else(|| TENOR_GIF_RE.find(token))
                            .map(|m| m.as_str())
                            .unwrap_or(token);
                        if matched.len() > 25 {
                            // Strip common surrounding characters
                            let clean: String = matched.chars()
                                .filter(|c| !matches!(c, '`' | '"' | '|' | '\'' | '{' | '}' | '[' | ']'))
                                .collect();
                            attachments.push(clean);
                        }
                    }
                }
            }
        }

        // Curse word extraction
        if want_cursed {
            for found in CURSE_RE.find_iter(&contents.to_lowercase()) {
                push_count(&mut cursed_words, found.as_str());
            }
        }

        // Emoji analysis
        if want_emojis {
            for character in contents.chars() {
                if is_supported_emoji(character) {
                    push_count(&mut emojis, &character.to_string());
                }
            }
        }

        if want_custom_emojis {
            let lower = contents.to_lowercase();
            for found in CUSTOM_EMOJI_RE.find_iter(&lower) {
                push_count(&mut custom_emojis, found.as_str());
            }
        }

        // Mention counting
        if want_mentions {
            mention_count.channel += CHANNEL_MENTION_RE.find_iter(contents).count() as u32;
            mention_count.user += USER_MENTION_RE.find_iter(contents).count() as u32;
            mention_count.role += ROLE_MENTION_RE.find_iter(contents).count() as u32;
            mention_count.here += contents.matches("@here").count() as u32;
            mention_count.everyone += contents.matches("@everyone").count() as u32;
        }
    }

    // Sort oldest messages by timestamp and keep top 100
    if want_oldest {
        oldest_messages.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
        oldest_messages.truncate(100);
    }

    let result = ChannelAnalysis {
        message_count,
        character_count,
        favorite_words: if want_words { to_word_entries(favorite_words, 1000) } else { vec![] },
        top_cursed: if want_cursed { to_word_entries(cursed_words, 1000) } else { vec![] },
        top_links: if want_links { to_word_entries(links, 1000) } else { vec![] },
        top_discord_links: if want_discord_links { to_word_entries(discord_links, 1000) } else { vec![] },
        top_emojis: if want_emojis { to_emoji_entries(emojis, 1000) } else { vec![] },
        top_custom_emojis: if want_custom_emojis { to_emoji_entries(custom_emojis, 1000) } else { vec![] },
        mention_count,
        hours_values,
        oldest_messages,
        attachments,
    };

    serde_json::to_string(&result).unwrap_or_else(|_| String::from("{}"))
}

/// Scan analytics text for event occurrences without JSON parsing.
/// `event_names_json`: JSON array of event names to count
/// Returns JSON object: { "eventName": count, ... }
#[wasm_bindgen]
pub fn scan_analytics_events(text: &str, event_names_json: &str) -> String {
    let event_names: Vec<String> = serde_json::from_str(event_names_json).unwrap_or_default();
    let counts = scan_analytics_counts(text, &event_names);

    serde_json::to_string(&counts).unwrap_or_else(|_| String::from("{}"))
}

#[wasm_bindgen]
pub fn analyze_text(text: &str) -> String {
    let mut favorite_words = HashMap::new();
    let mut links = HashMap::new();
    let mut discord_links = HashMap::new();
    let mut emojis = HashMap::new();
    let mut custom_emojis = HashMap::new();

    for token in text.split_whitespace() {
        if token.chars().count() > 3 {
            push_count(&mut favorite_words, token);
        }

        if let Some(found) = URL_RE.find(token) {
            let url = found.as_str();
            if url.len() > 3 {
                push_count(&mut links, url);
            }
        }

        if let Some(found) = DISCORD_INVITE_RE.find(token) {
            let invite = found.as_str();
            if invite.len() > 15 {
                push_count(&mut discord_links, invite);
            }
        }
    }

    for character in text.chars() {
        if is_supported_emoji(character) {
            push_count(&mut emojis, &character.to_string());
        }
    }

    let lower_text = text.to_lowercase();
    for found in CUSTOM_EMOJI_RE.find_iter(&lower_text) {
        push_count(&mut custom_emojis, found.as_str());
    }

    let mention_count = MentionCount {
        channel: CHANNEL_MENTION_RE.find_iter(text).count() as u32,
        user: USER_MENTION_RE.find_iter(text).count() as u32,
        role: ROLE_MENTION_RE.find_iter(text).count() as u32,
        here: text.matches("@here").count() as u32,
        everyone: text.matches("@everyone").count() as u32,
    };

    let result = AnalysisResult {
        favorite_words: to_word_entries(favorite_words, 1000),
        top_links: to_word_entries(links, 1000),
        top_discord_links: to_word_entries(discord_links, 1000),
        top_emojis: to_emoji_entries(emojis, 1000),
        top_custom_emojis: to_emoji_entries(custom_emojis, 1000),
        mention_count,
    };

    serde_json::to_string(&result).unwrap_or_else(|_| String::from("{}"))
}