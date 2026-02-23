/**
 * Bible Verse Lookup — Red Letter Edition
 *
 * Provides instant Bible verse lookups from the search bar.
 * Uses the KJV (King James Version) — public domain.
 * Words of Jesus are tagged for red-letter rendering.
 *
 * Data is fetched per-chapter from GitHub on first use and cached in memory.
 * After first load, lookups are instant (<1ms).
 *
 * Data source: github.com/jburson/bible-data (word-level *r markup for red-letter)
 */

// ─── Types ───────────────────────────────────────────────────────

/** A segment of verse text — either normal or red-letter (words of Jesus). */
export interface VerseSegment {
  text: string;
  red: boolean;
}

/** Structured verse data with red-letter segments. */
interface VerseData {
  /** Plain text (no markup) for clipboard copy */
  plainText: string;
  /** Segments with red-letter flag for rendering */
  segments: VerseSegment[];
}

export interface BibleResult {
  input: string;
  inputLabel: string;
  result: string;
  resultLabel: string;
  /** Full reference string, e.g. "John 3:16" */
  reference: string;
  /** Plain verse text for clipboard */
  verseText: string;
  /** Segments with red-letter markup for rendering */
  segments: VerseSegment[];
}

// ─── Book name normalization ─────────────────────────────────────

interface BookInfo {
  /** Directory name in the jburson/bible-data repo (e.g. "1 Corinthians") */
  dirName: string;
  /** Display name (e.g. "1 Corinthians") */
  displayName: string;
  /** Number of chapters in this book */
  chapters: number;
}

const BOOKS: Array<{ aliases: string[]; info: BookInfo }> = [
  { aliases: ['genesis', 'gen', 'ge', 'gn'], info: { dirName: 'Genesis', displayName: 'Genesis', chapters: 50 } },
  { aliases: ['exodus', 'exod', 'exo', 'ex'], info: { dirName: 'Exodus', displayName: 'Exodus', chapters: 40 } },
  { aliases: ['leviticus', 'lev', 'le', 'lv'], info: { dirName: 'Leviticus', displayName: 'Leviticus', chapters: 27 } },
  { aliases: ['numbers', 'num', 'nu', 'nm', 'nb'], info: { dirName: 'Numbers', displayName: 'Numbers', chapters: 36 } },
  { aliases: ['deuteronomy', 'deut', 'de', 'dt'], info: { dirName: 'Deuteronomy', displayName: 'Deuteronomy', chapters: 34 } },
  { aliases: ['joshua', 'josh', 'jos', 'jsh'], info: { dirName: 'Joshua', displayName: 'Joshua', chapters: 24 } },
  { aliases: ['judges', 'judg', 'jdg', 'jg', 'jdgs'], info: { dirName: 'Judges', displayName: 'Judges', chapters: 21 } },
  { aliases: ['ruth', 'rth', 'ru'], info: { dirName: 'Ruth', displayName: 'Ruth', chapters: 4 } },
  { aliases: ['1 samuel', '1samuel', '1sam', '1 sam', '1sa', '1sm', 'i samuel', 'i sam'], info: { dirName: '1 Samuel', displayName: '1 Samuel', chapters: 31 } },
  { aliases: ['2 samuel', '2samuel', '2sam', '2 sam', '2sa', '2sm', 'ii samuel', 'ii sam'], info: { dirName: '2 Samuel', displayName: '2 Samuel', chapters: 24 } },
  { aliases: ['1 kings', '1kings', '1kgs', '1 kgs', '1ki', 'i kings', 'i kgs'], info: { dirName: '1 Kings', displayName: '1 Kings', chapters: 22 } },
  { aliases: ['2 kings', '2kings', '2kgs', '2 kgs', '2ki', 'ii kings', 'ii kgs'], info: { dirName: '2 Kings', displayName: '2 Kings', chapters: 25 } },
  { aliases: ['1 chronicles', '1chronicles', '1chr', '1 chr', '1ch', 'i chronicles', 'i chr'], info: { dirName: '1 Chronicles', displayName: '1 Chronicles', chapters: 29 } },
  { aliases: ['2 chronicles', '2chronicles', '2chr', '2 chr', '2ch', 'ii chronicles', 'ii chr'], info: { dirName: '2 Chronicles', displayName: '2 Chronicles', chapters: 36 } },
  { aliases: ['ezra', 'ezr', 'ez'], info: { dirName: 'Ezra', displayName: 'Ezra', chapters: 10 } },
  { aliases: ['nehemiah', 'neh', 'ne'], info: { dirName: 'Nehemiah', displayName: 'Nehemiah', chapters: 13 } },
  { aliases: ['esther', 'est', 'esth', 'es'], info: { dirName: 'Esther', displayName: 'Esther', chapters: 10 } },
  { aliases: ['job', 'jb'], info: { dirName: 'Job', displayName: 'Job', chapters: 42 } },
  { aliases: ['psalms', 'psalm', 'ps', 'psa', 'psm', 'pss'], info: { dirName: 'Psalm', displayName: 'Psalms', chapters: 150 } },
  { aliases: ['proverbs', 'prov', 'pro', 'prv', 'pr'], info: { dirName: 'Proverbs', displayName: 'Proverbs', chapters: 31 } },
  { aliases: ['ecclesiastes', 'eccles', 'eccl', 'ecc', 'ec', 'qoh'], info: { dirName: 'Ecclesiastes', displayName: 'Ecclesiastes', chapters: 12 } },
  { aliases: ['song of solomon', 'songofsolomon', 'song', 'sos', 'sg', 'song of songs', 'canticles', 'canticle'], info: { dirName: 'Song of Solomon', displayName: 'Song of Solomon', chapters: 8 } },
  { aliases: ['isaiah', 'isa', 'is'], info: { dirName: 'Isaiah', displayName: 'Isaiah', chapters: 66 } },
  { aliases: ['jeremiah', 'jer', 'je', 'jr'], info: { dirName: 'Jeremiah', displayName: 'Jeremiah', chapters: 52 } },
  { aliases: ['lamentations', 'lam', 'la'], info: { dirName: 'Lamentations', displayName: 'Lamentations', chapters: 5 } },
  { aliases: ['ezekiel', 'ezek', 'eze', 'ezk'], info: { dirName: 'Ezekiel', displayName: 'Ezekiel', chapters: 48 } },
  { aliases: ['daniel', 'dan', 'da', 'dn'], info: { dirName: 'Daniel', displayName: 'Daniel', chapters: 12 } },
  { aliases: ['hosea', 'hos', 'ho'], info: { dirName: 'Hosea', displayName: 'Hosea', chapters: 14 } },
  { aliases: ['joel', 'joe', 'jl'], info: { dirName: 'Joel', displayName: 'Joel', chapters: 3 } },
  { aliases: ['amos', 'amo', 'am'], info: { dirName: 'Amos', displayName: 'Amos', chapters: 9 } },
  { aliases: ['obadiah', 'obad', 'ob'], info: { dirName: 'Obadiah', displayName: 'Obadiah', chapters: 1 } },
  { aliases: ['jonah', 'jnh', 'jon'], info: { dirName: 'Jonah', displayName: 'Jonah', chapters: 4 } },
  { aliases: ['micah', 'mic', 'mc'], info: { dirName: 'Micah', displayName: 'Micah', chapters: 7 } },
  { aliases: ['nahum', 'nah', 'na'], info: { dirName: 'Nahum', displayName: 'Nahum', chapters: 3 } },
  { aliases: ['habakkuk', 'hab', 'hb'], info: { dirName: 'Habakkuk', displayName: 'Habakkuk', chapters: 3 } },
  { aliases: ['zephaniah', 'zeph', 'zep', 'zp'], info: { dirName: 'Zephaniah', displayName: 'Zephaniah', chapters: 3 } },
  { aliases: ['haggai', 'hag', 'hg'], info: { dirName: 'Haggai', displayName: 'Haggai', chapters: 2 } },
  { aliases: ['zechariah', 'zech', 'zec', 'zc'], info: { dirName: 'Zechariah', displayName: 'Zechariah', chapters: 14 } },
  { aliases: ['malachi', 'mal', 'ml'], info: { dirName: 'Malachi', displayName: 'Malachi', chapters: 4 } },
  // New Testament
  { aliases: ['matthew', 'matt', 'mat', 'mt'], info: { dirName: 'Matthew', displayName: 'Matthew', chapters: 28 } },
  { aliases: ['mark', 'mrk', 'mk', 'mr'], info: { dirName: 'Mark', displayName: 'Mark', chapters: 16 } },
  { aliases: ['luke', 'luk', 'lk'], info: { dirName: 'Luke', displayName: 'Luke', chapters: 24 } },
  { aliases: ['john', 'jhn', 'jn'], info: { dirName: 'John', displayName: 'John', chapters: 21 } },
  { aliases: ['acts', 'act', 'ac'], info: { dirName: 'Acts', displayName: 'Acts', chapters: 28 } },
  { aliases: ['romans', 'rom', 'ro', 'rm'], info: { dirName: 'Romans', displayName: 'Romans', chapters: 16 } },
  { aliases: ['1 corinthians', '1corinthians', '1cor', '1 cor', '1co', 'i corinthians', 'i cor'], info: { dirName: '1 Corinthians', displayName: '1 Corinthians', chapters: 16 } },
  { aliases: ['2 corinthians', '2corinthians', '2cor', '2 cor', '2co', 'ii corinthians', 'ii cor'], info: { dirName: '2 Corinthians', displayName: '2 Corinthians', chapters: 13 } },
  { aliases: ['galatians', 'gal', 'ga'], info: { dirName: 'Galatians', displayName: 'Galatians', chapters: 6 } },
  { aliases: ['ephesians', 'eph', 'ephes'], info: { dirName: 'Ephesians', displayName: 'Ephesians', chapters: 6 } },
  { aliases: ['philippians', 'phil', 'php', 'pp'], info: { dirName: 'Philippians', displayName: 'Philippians', chapters: 4 } },
  { aliases: ['colossians', 'col', 'co'], info: { dirName: 'Colossians', displayName: 'Colossians', chapters: 4 } },
  { aliases: ['1 thessalonians', '1thessalonians', '1thess', '1 thess', '1th', 'i thessalonians', 'i thess'], info: { dirName: '1 Thessalonians', displayName: '1 Thessalonians', chapters: 5 } },
  { aliases: ['2 thessalonians', '2thessalonians', '2thess', '2 thess', '2th', 'ii thessalonians', 'ii thess'], info: { dirName: '2 Thessalonians', displayName: '2 Thessalonians', chapters: 3 } },
  { aliases: ['1 timothy', '1timothy', '1tim', '1 tim', '1ti', 'i timothy', 'i tim'], info: { dirName: '1 Timothy', displayName: '1 Timothy', chapters: 6 } },
  { aliases: ['2 timothy', '2timothy', '2tim', '2 tim', '2ti', 'ii timothy', 'ii tim'], info: { dirName: '2 Timothy', displayName: '2 Timothy', chapters: 4 } },
  { aliases: ['titus', 'tit', 'ti'], info: { dirName: 'Titus', displayName: 'Titus', chapters: 3 } },
  { aliases: ['philemon', 'philem', 'phm', 'pm'], info: { dirName: 'Philemon', displayName: 'Philemon', chapters: 1 } },
  { aliases: ['hebrews', 'heb', 'he'], info: { dirName: 'Hebrews', displayName: 'Hebrews', chapters: 13 } },
  { aliases: ['james', 'jas', 'jm'], info: { dirName: 'James', displayName: 'James', chapters: 5 } },
  { aliases: ['1 peter', '1peter', '1pet', '1 pet', '1pe', '1pt', 'i peter', 'i pet'], info: { dirName: '1 Peter', displayName: '1 Peter', chapters: 5 } },
  { aliases: ['2 peter', '2peter', '2pet', '2 pet', '2pe', '2pt', 'ii peter', 'ii pet'], info: { dirName: '2 Peter', displayName: '2 Peter', chapters: 3 } },
  { aliases: ['1 john', '1john', '1jn', '1 jn', '1jo', 'i john', 'i jn'], info: { dirName: '1 John', displayName: '1 John', chapters: 5 } },
  { aliases: ['2 john', '2john', '2jn', '2 jn', '2jo', 'ii john', 'ii jn'], info: { dirName: '2 John', displayName: '2 John', chapters: 1 } },
  { aliases: ['3 john', '3john', '3jn', '3 jn', '3jo', 'iii john', 'iii jn'], info: { dirName: '3 John', displayName: '3 John', chapters: 1 } },
  { aliases: ['jude', 'jud', 'jd'], info: { dirName: 'Jude', displayName: 'Jude', chapters: 1 } },
  { aliases: ['revelation', 'rev', 're', 'revelations'], info: { dirName: 'Revelation', displayName: 'Revelation', chapters: 22 } },
];

/** Build a fast lookup map from alias -> BookInfo */
const aliasMap = new Map<string, BookInfo>();
for (const book of BOOKS) {
  for (const alias of book.aliases) {
    aliasMap.set(alias, book.info);
  }
}

// ─── Verse reference parsing ──────────────────────────────────────

interface ParsedRef {
  book: BookInfo;
  chapter: number;
  verseStart: number | null;
  verseEnd: number | null;
}

const VERSE_RE = /^([1-3]?\s*[a-z][a-z\s]*?)\s+(\d{1,3})(?::(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?$/i;

function parseReference(query: string): ParsedRef | null {
  const trimmed = query.trim();
  const m = VERSE_RE.exec(trimmed);
  if (!m) return null;

  const bookInput = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const chapter = parseInt(m[2], 10);
  const verseStart = m[3] ? parseInt(m[3], 10) : null;
  const verseEnd = m[4] ? parseInt(m[4], 10) : null;

  let book = aliasMap.get(bookInput);
  if (!book) book = aliasMap.get(bookInput.replace(/\s+/g, ''));
  if (!book) {
    for (const [alias, info] of aliasMap) {
      if (alias.startsWith(bookInput) && bookInput.length >= 3) {
        book = info;
        break;
      }
    }
  }

  if (!book) return null;
  if (chapter < 1 || chapter > book.chapters) return null;

  return { book, chapter, verseStart, verseEnd };
}

// ─── Markup parsing ───────────────────────────────────────────────

/**
 * Parse jburson/bible-data markup into VerseSegments.
 *
 * Format: each word may have flags appended with *.
 *   "Jesus*p answered and said unto him, Verily,*r verily,*r I*r say*r..."
 *
 * Flags: r = red-letter (words of Jesus), p = paragraph, s = smallcaps, etc.
 * We only care about `r`.
 */
function parseMarkup(rawText: string): VerseData {
  // Split into words while preserving spaces
  const tokens = rawText.split(/(\s+)/);
  const segments: VerseSegment[] = [];
  const plainParts: string[] = [];

  for (const token of tokens) {
    // Whitespace — just preserve it
    if (/^\s+$/.test(token)) {
      plainParts.push(token);
      // Append to last segment if exists
      if (segments.length > 0) {
        segments[segments.length - 1].text += token;
      }
      continue;
    }

    // Parse flags from word: "word*rp" → word="word", flags="rp"
    const flagIdx = token.indexOf('*');
    let word: string;
    let isRed = false;

    if (flagIdx >= 0) {
      word = token.slice(0, flagIdx);
      const flags = token.slice(flagIdx + 1);
      isRed = flags.includes('r');
    } else {
      word = token;
    }

    plainParts.push(word);

    // Merge with previous segment if same red state
    if (segments.length > 0 && segments[segments.length - 1].red === isRed) {
      segments[segments.length - 1].text += word;
    } else {
      segments.push({ text: word, red: isRed });
    }
  }

  return {
    plainText: plainParts.join(''),
    segments: segments.filter((s) => s.text.length > 0),
  };
}

// ─── Data fetching & caching ──────────────────────────────────────

const BASE_URL = 'https://raw.githubusercontent.com/jburson/bible-data/main/data/kjv/books';

/** Cache key: "BookDir/chapter" → Map<verseNumber, VerseData> */
const chapterCache = new Map<string, Map<number, VerseData>>();

/** Dedup concurrent fetches */
const pendingFetches = new Map<string, Promise<Map<number, VerseData> | null>>();

function chapterCacheKey(dirName: string, chapter: number): string {
  return `${dirName}/${chapter}`;
}

async function fetchChapter(dirName: string, chapter: number): Promise<Map<number, VerseData> | null> {
  const key = chapterCacheKey(dirName, chapter);

  if (chapterCache.has(key)) return chapterCache.get(key)!;
  if (pendingFetches.has(key)) return pendingFetches.get(key)!;

  const promise = (async (): Promise<Map<number, VerseData> | null> => {
    try {
      // URL encodes spaces in directory names
      const encodedDir = encodeURIComponent(dirName);
      const url = `${BASE_URL}/${encodedDir}/chapters/${chapter}/${chapter}.json`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const data: Array<{ o: number; r: string; t: string; h?: number }> = await res.json();
      const verses = new Map<number, VerseData>();

      for (const entry of data) {
        // Skip chapter headers (h > 0)
        if (entry.h) continue;

        // Extract verse number from reference "kjv:Book:chapter:verse"
        const parts = entry.r.split(':');
        const verseNum = parseInt(parts[parts.length - 1], 10);
        if (isNaN(verseNum) || verseNum < 1) continue;

        verses.set(verseNum, parseMarkup(entry.t));
      }

      chapterCache.set(key, verses);
      return verses;
    } catch {
      return null;
    } finally {
      pendingFetches.delete(key);
    }
  })();

  pendingFetches.set(key, promise);
  return promise;
}

// ─── Public API ────────────────────────────────────────────────────

/**
 * Synchronously check if a query looks like a Bible reference.
 */
export function isBibleReference(query: string): ParsedRef | null {
  return parseReference(query);
}

function formatReference(ref: ParsedRef): string {
  const { book, chapter, verseStart, verseEnd } = ref;
  if (verseStart === null) return `${book.displayName} ${chapter}`;
  if (verseEnd !== null) return `${book.displayName} ${chapter}:${verseStart}-${verseEnd}`;
  return `${book.displayName} ${chapter}:${verseStart}`;
}

/**
 * Look up a Bible verse asynchronously.
 * Returns structured data with red-letter segments.
 */
export async function lookupBibleVerse(query: string): Promise<BibleResult | null> {
  const ref = parseReference(query);
  if (!ref) return null;

  const chapter = await fetchChapter(ref.book.dirName, ref.chapter);
  if (!chapter) return null;

  const reference = formatReference(ref);

  // No verse specified → return first verse of the chapter
  if (ref.verseStart === null) {
    const verse = chapter.get(1);
    if (!verse) return null;
    return {
      input: reference,
      inputLabel: 'Bible Reference',
      result: verse.plainText,
      resultLabel: `KJV — ${ref.book.displayName} ${ref.chapter}:1`,
      reference,
      verseText: verse.plainText,
      segments: verse.segments,
    };
  }

  // Single verse
  if (ref.verseEnd === null) {
    const verse = chapter.get(ref.verseStart);
    if (!verse) return null;
    return {
      input: reference,
      inputLabel: 'Bible Reference',
      result: verse.plainText,
      resultLabel: 'King James Version',
      reference,
      verseText: verse.plainText,
      segments: verse.segments,
    };
  }

  // Verse range — combine multiple verses
  const allSegments: VerseSegment[] = [];
  const plainParts: string[] = [];

  for (let v = ref.verseStart; v <= ref.verseEnd; v++) {
    const verse = chapter.get(v);
    if (!verse) continue;

    // Add verse number prefix (not red)
    if (allSegments.length > 0) {
      allSegments.push({ text: ' ', red: false });
      plainParts.push(' ');
    }
    allSegments.push({ text: `${v} `, red: false });
    plainParts.push(`${v} `);

    // Add verse segments
    for (const seg of verse.segments) {
      allSegments.push(seg);
    }
    plainParts.push(verse.plainText);
  }

  if (allSegments.length === 0) return null;

  const combinedText = plainParts.join('');
  return {
    input: reference,
    inputLabel: 'Bible Reference',
    result: combinedText,
    resultLabel: 'King James Version',
    reference,
    verseText: combinedText,
    segments: allSegments,
  };
}
