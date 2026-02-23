/**
 * Bible Verse Lookup
 *
 * Provides instant Bible verse lookups from the search bar.
 * Uses the KJV (King James Version) — public domain.
 *
 * Data is fetched per-book from GitHub on first use and cached in memory.
 * After first load, lookups are instant (<1ms).
 */

import type { CalcResult } from './smart-calculator';

// ─── Book name normalization ─────────────────────────────────────

interface BookInfo {
  /** Canonical name used in the GitHub JSON file (e.g. "1Corinthians") */
  fileName: string;
  /** Display name (e.g. "1 Corinthians") */
  displayName: string;
  /** Number of chapters in this book */
  chapters: number;
}

/**
 * All 66 books with their aliases, file names, and chapter counts.
 * Aliases include common abbreviations, full names, and short forms.
 */
const BOOKS: Array<{ aliases: string[]; info: BookInfo }> = [
  { aliases: ['genesis', 'gen', 'ge', 'gn'], info: { fileName: 'Genesis', displayName: 'Genesis', chapters: 50 } },
  { aliases: ['exodus', 'exod', 'exo', 'ex'], info: { fileName: 'Exodus', displayName: 'Exodus', chapters: 40 } },
  { aliases: ['leviticus', 'lev', 'le', 'lv'], info: { fileName: 'Leviticus', displayName: 'Leviticus', chapters: 27 } },
  { aliases: ['numbers', 'num', 'nu', 'nm', 'nb'], info: { fileName: 'Numbers', displayName: 'Numbers', chapters: 36 } },
  { aliases: ['deuteronomy', 'deut', 'de', 'dt'], info: { fileName: 'Deuteronomy', displayName: 'Deuteronomy', chapters: 34 } },
  { aliases: ['joshua', 'josh', 'jos', 'jsh'], info: { fileName: 'Joshua', displayName: 'Joshua', chapters: 24 } },
  { aliases: ['judges', 'judg', 'jdg', 'jg', 'jdgs'], info: { fileName: 'Judges', displayName: 'Judges', chapters: 21 } },
  { aliases: ['ruth', 'rth', 'ru'], info: { fileName: 'Ruth', displayName: 'Ruth', chapters: 4 } },
  { aliases: ['1 samuel', '1samuel', '1sam', '1 sam', '1sa', '1sm', 'i samuel', 'i sam'], info: { fileName: '1Samuel', displayName: '1 Samuel', chapters: 31 } },
  { aliases: ['2 samuel', '2samuel', '2sam', '2 sam', '2sa', '2sm', 'ii samuel', 'ii sam'], info: { fileName: '2Samuel', displayName: '2 Samuel', chapters: 24 } },
  { aliases: ['1 kings', '1kings', '1kgs', '1 kgs', '1ki', 'i kings', 'i kgs'], info: { fileName: '1Kings', displayName: '1 Kings', chapters: 22 } },
  { aliases: ['2 kings', '2kings', '2kgs', '2 kgs', '2ki', 'ii kings', 'ii kgs'], info: { fileName: '2Kings', displayName: '2 Kings', chapters: 25 } },
  { aliases: ['1 chronicles', '1chronicles', '1chr', '1 chr', '1ch', 'i chronicles', 'i chr'], info: { fileName: '1Chronicles', displayName: '1 Chronicles', chapters: 29 } },
  { aliases: ['2 chronicles', '2chronicles', '2chr', '2 chr', '2ch', 'ii chronicles', 'ii chr'], info: { fileName: '2Chronicles', displayName: '2 Chronicles', chapters: 36 } },
  { aliases: ['ezra', 'ezr', 'ez'], info: { fileName: 'Ezra', displayName: 'Ezra', chapters: 10 } },
  { aliases: ['nehemiah', 'neh', 'ne'], info: { fileName: 'Nehemiah', displayName: 'Nehemiah', chapters: 13 } },
  { aliases: ['esther', 'est', 'esth', 'es'], info: { fileName: 'Esther', displayName: 'Esther', chapters: 10 } },
  { aliases: ['job', 'jb'], info: { fileName: 'Job', displayName: 'Job', chapters: 42 } },
  { aliases: ['psalms', 'psalm', 'ps', 'psa', 'psm', 'pss'], info: { fileName: 'Psalms', displayName: 'Psalms', chapters: 150 } },
  { aliases: ['proverbs', 'prov', 'pro', 'prv', 'pr'], info: { fileName: 'Proverbs', displayName: 'Proverbs', chapters: 31 } },
  { aliases: ['ecclesiastes', 'eccles', 'eccl', 'ecc', 'ec', 'qoh'], info: { fileName: 'Ecclesiastes', displayName: 'Ecclesiastes', chapters: 12 } },
  { aliases: ['song of solomon', 'songofsolomon', 'song', 'sos', 'sg', 'song of songs', 'canticles', 'canticle'], info: { fileName: 'SongofSolomon', displayName: 'Song of Solomon', chapters: 8 } },
  { aliases: ['isaiah', 'isa', 'is'], info: { fileName: 'Isaiah', displayName: 'Isaiah', chapters: 66 } },
  { aliases: ['jeremiah', 'jer', 'je', 'jr'], info: { fileName: 'Jeremiah', displayName: 'Jeremiah', chapters: 52 } },
  { aliases: ['lamentations', 'lam', 'la'], info: { fileName: 'Lamentations', displayName: 'Lamentations', chapters: 5 } },
  { aliases: ['ezekiel', 'ezek', 'eze', 'ezk'], info: { fileName: 'Ezekiel', displayName: 'Ezekiel', chapters: 48 } },
  { aliases: ['daniel', 'dan', 'da', 'dn'], info: { fileName: 'Daniel', displayName: 'Daniel', chapters: 12 } },
  { aliases: ['hosea', 'hos', 'ho'], info: { fileName: 'Hosea', displayName: 'Hosea', chapters: 14 } },
  { aliases: ['joel', 'joe', 'jl'], info: { fileName: 'Joel', displayName: 'Joel', chapters: 3 } },
  { aliases: ['amos', 'amo', 'am'], info: { fileName: 'Amos', displayName: 'Amos', chapters: 9 } },
  { aliases: ['obadiah', 'obad', 'ob'], info: { fileName: 'Obadiah', displayName: 'Obadiah', chapters: 1 } },
  { aliases: ['jonah', 'jnh', 'jon'], info: { fileName: 'Jonah', displayName: 'Jonah', chapters: 4 } },
  { aliases: ['micah', 'mic', 'mc'], info: { fileName: 'Micah', displayName: 'Micah', chapters: 7 } },
  { aliases: ['nahum', 'nah', 'na'], info: { fileName: 'Nahum', displayName: 'Nahum', chapters: 3 } },
  { aliases: ['habakkuk', 'hab', 'hb'], info: { fileName: 'Habakkuk', displayName: 'Habakkuk', chapters: 3 } },
  { aliases: ['zephaniah', 'zeph', 'zep', 'zp'], info: { fileName: 'Zephaniah', displayName: 'Zephaniah', chapters: 3 } },
  { aliases: ['haggai', 'hag', 'hg'], info: { fileName: 'Haggai', displayName: 'Haggai', chapters: 2 } },
  { aliases: ['zechariah', 'zech', 'zec', 'zc'], info: { fileName: 'Zechariah', displayName: 'Zechariah', chapters: 14 } },
  { aliases: ['malachi', 'mal', 'ml'], info: { fileName: 'Malachi', displayName: 'Malachi', chapters: 4 } },
  // New Testament
  { aliases: ['matthew', 'matt', 'mat', 'mt'], info: { fileName: 'Matthew', displayName: 'Matthew', chapters: 28 } },
  { aliases: ['mark', 'mrk', 'mk', 'mr'], info: { fileName: 'Mark', displayName: 'Mark', chapters: 16 } },
  { aliases: ['luke', 'luk', 'lk'], info: { fileName: 'Luke', displayName: 'Luke', chapters: 24 } },
  { aliases: ['john', 'jhn', 'jn'], info: { fileName: 'John', displayName: 'John', chapters: 21 } },
  { aliases: ['acts', 'act', 'ac'], info: { fileName: 'Acts', displayName: 'Acts', chapters: 28 } },
  { aliases: ['romans', 'rom', 'ro', 'rm'], info: { fileName: 'Romans', displayName: 'Romans', chapters: 16 } },
  { aliases: ['1 corinthians', '1corinthians', '1cor', '1 cor', '1co', 'i corinthians', 'i cor'], info: { fileName: '1Corinthians', displayName: '1 Corinthians', chapters: 16 } },
  { aliases: ['2 corinthians', '2corinthians', '2cor', '2 cor', '2co', 'ii corinthians', 'ii cor'], info: { fileName: '2Corinthians', displayName: '2 Corinthians', chapters: 13 } },
  { aliases: ['galatians', 'gal', 'ga'], info: { fileName: 'Galatians', displayName: 'Galatians', chapters: 6 } },
  { aliases: ['ephesians', 'eph', 'ephes'], info: { fileName: 'Ephesians', displayName: 'Ephesians', chapters: 6 } },
  { aliases: ['philippians', 'phil', 'php', 'pp'], info: { fileName: 'Philippians', displayName: 'Philippians', chapters: 4 } },
  { aliases: ['colossians', 'col', 'co'], info: { fileName: 'Colossians', displayName: 'Colossians', chapters: 4 } },
  { aliases: ['1 thessalonians', '1thessalonians', '1thess', '1 thess', '1th', 'i thessalonians', 'i thess'], info: { fileName: '1Thessalonians', displayName: '1 Thessalonians', chapters: 5 } },
  { aliases: ['2 thessalonians', '2thessalonians', '2thess', '2 thess', '2th', 'ii thessalonians', 'ii thess'], info: { fileName: '2Thessalonians', displayName: '2 Thessalonians', chapters: 3 } },
  { aliases: ['1 timothy', '1timothy', '1tim', '1 tim', '1ti', 'i timothy', 'i tim'], info: { fileName: '1Timothy', displayName: '1 Timothy', chapters: 6 } },
  { aliases: ['2 timothy', '2timothy', '2tim', '2 tim', '2ti', 'ii timothy', 'ii tim'], info: { fileName: '2Timothy', displayName: '2 Timothy', chapters: 4 } },
  { aliases: ['titus', 'tit', 'ti'], info: { fileName: 'Titus', displayName: 'Titus', chapters: 3 } },
  { aliases: ['philemon', 'philem', 'phm', 'pm'], info: { fileName: 'Philemon', displayName: 'Philemon', chapters: 1 } },
  { aliases: ['hebrews', 'heb', 'he'], info: { fileName: 'Hebrews', displayName: 'Hebrews', chapters: 13 } },
  { aliases: ['james', 'jas', 'jm'], info: { fileName: 'James', displayName: 'James', chapters: 5 } },
  { aliases: ['1 peter', '1peter', '1pet', '1 pet', '1pe', '1pt', 'i peter', 'i pet'], info: { fileName: '1Peter', displayName: '1 Peter', chapters: 5 } },
  { aliases: ['2 peter', '2peter', '2pet', '2 pet', '2pe', '2pt', 'ii peter', 'ii pet'], info: { fileName: '2Peter', displayName: '2 Peter', chapters: 3 } },
  { aliases: ['1 john', '1john', '1jn', '1 jn', '1jo', 'i john', 'i jn'], info: { fileName: '1John', displayName: '1 John', chapters: 5 } },
  { aliases: ['2 john', '2john', '2jn', '2 jn', '2jo', 'ii john', 'ii jn'], info: { fileName: '2John', displayName: '2 John', chapters: 1 } },
  { aliases: ['3 john', '3john', '3jn', '3 jn', '3jo', 'iii john', 'iii jn'], info: { fileName: '3John', displayName: '3 John', chapters: 1 } },
  { aliases: ['jude', 'jud', 'jd'], info: { fileName: 'Jude', displayName: 'Jude', chapters: 1 } },
  { aliases: ['revelation', 'rev', 're', 'revelations'], info: { fileName: 'Revelation', displayName: 'Revelation', chapters: 22 } },
];

/** Build a fast lookup map from alias → BookInfo */
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

/**
 * Parse a Bible reference from user input.
 *
 * Supported formats:
 *   "John 3:16"
 *   "John 3:16-18"
 *   "Gen 1:1"
 *   "1 Cor 13:4-7"
 *   "Psalm 23"
 *   "Rev 21:4"
 *   "genesis 1:1"
 */
const VERSE_RE = /^([1-3]?\s*[a-z][a-z\s]*?)\s+(\d{1,3})(?::(\d{1,3})(?:\s*-\s*(\d{1,3}))?)?$/i;

function parseReference(query: string): ParsedRef | null {
  const trimmed = query.trim();
  const m = VERSE_RE.exec(trimmed);
  if (!m) return null;

  const bookInput = m[1].toLowerCase().replace(/\s+/g, ' ').trim();
  const chapter = parseInt(m[2], 10);
  const verseStart = m[3] ? parseInt(m[3], 10) : null;
  const verseEnd = m[4] ? parseInt(m[4], 10) : null;

  // Try exact alias match first
  let book = aliasMap.get(bookInput);

  // Try without spaces (e.g. "1 samuel" → "1samuel")
  if (!book) {
    book = aliasMap.get(bookInput.replace(/\s+/g, ''));
  }

  // Try prefix match for longer book names
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

// ─── Data fetching & caching ──────────────────────────────────────

const BASE_URL = 'https://raw.githubusercontent.com/aruljohn/Bible-kjv/master';

interface BookData {
  chapters: Map<number, Map<number, string>>;
}

/** In-memory cache of fetched books */
const bookCache = new Map<string, BookData>();

/** Books currently being fetched (dedup concurrent requests) */
const pendingFetches = new Map<string, Promise<BookData | null>>();

async function fetchBook(fileName: string): Promise<BookData | null> {
  // Return from cache
  if (bookCache.has(fileName)) return bookCache.get(fileName)!;

  // Dedup concurrent fetches
  if (pendingFetches.has(fileName)) return pendingFetches.get(fileName)!;

  const promise = (async (): Promise<BookData | null> => {
    try {
      const res = await fetch(`${BASE_URL}/${fileName}.json`);
      if (!res.ok) return null;

      const data = await res.json();
      const chapters = new Map<number, Map<number, string>>();

      for (const ch of data.chapters) {
        const verses = new Map<number, string>();
        for (const v of ch.verses) {
          verses.set(parseInt(v.verse, 10), v.text);
        }
        chapters.set(parseInt(ch.chapter, 10), verses);
      }

      const bookData: BookData = { chapters };
      bookCache.set(fileName, bookData);
      return bookData;
    } catch {
      return null;
    } finally {
      pendingFetches.delete(fileName);
    }
  })();

  pendingFetches.set(fileName, promise);
  return promise;
}

// ─── Public API ────────────────────────────────────────────────────

export interface BibleResult extends CalcResult {
  /** Full reference string, e.g. "John 3:16" */
  reference: string;
  /** The verse text */
  verseText: string;
}

/**
 * Synchronously check if a query looks like a Bible reference.
 * This is used to show a loading state before the async fetch completes.
 * Returns null if the query doesn't look like a Bible reference.
 */
export function isBibleReference(query: string): ParsedRef | null {
  return parseReference(query);
}

/**
 * Format a parsed reference as a display string.
 */
function formatReference(ref: ParsedRef): string {
  const { book, chapter, verseStart, verseEnd } = ref;
  if (verseStart === null) return `${book.displayName} ${chapter}`;
  if (verseEnd !== null) return `${book.displayName} ${chapter}:${verseStart}-${verseEnd}`;
  return `${book.displayName} ${chapter}:${verseStart}`;
}

/**
 * Look up a Bible verse asynchronously.
 * Fetches the book data on first use, then uses cached data.
 */
export async function lookupBibleVerse(query: string): Promise<BibleResult | null> {
  const ref = parseReference(query);
  if (!ref) return null;

  const bookData = await fetchBook(ref.book.fileName);
  if (!bookData) return null;

  const chapter = bookData.chapters.get(ref.chapter);
  if (!chapter) return null;

  const reference = formatReference(ref);

  // If no verse specified, return first verse of the chapter
  if (ref.verseStart === null) {
    const firstVerse = chapter.get(1);
    if (!firstVerse) return null;
    return {
      input: reference,
      inputLabel: 'Bible Reference',
      result: firstVerse,
      resultLabel: `KJV — ${ref.book.displayName} ${ref.chapter}:1`,
      reference,
      verseText: firstVerse,
    };
  }

  // Single verse
  if (ref.verseEnd === null) {
    const text = chapter.get(ref.verseStart);
    if (!text) return null;
    return {
      input: reference,
      inputLabel: 'Bible Reference',
      result: text,
      resultLabel: 'King James Version',
      reference,
      verseText: text,
    };
  }

  // Verse range
  const verses: string[] = [];
  for (let v = ref.verseStart; v <= ref.verseEnd; v++) {
    const text = chapter.get(v);
    if (text) verses.push(`${v} ${text}`);
  }
  if (verses.length === 0) return null;

  const combinedText = verses.join(' ');
  return {
    input: reference,
    inputLabel: 'Bible Reference',
    result: combinedText,
    resultLabel: 'King James Version',
    reference,
    verseText: combinedText,
  };
}
