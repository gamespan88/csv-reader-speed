// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader), written for the csv-reader-speed-01 bounty.
// run(input) returns exactly csv-reader's reading of {text, header} — {columns, rows, errors} — for every input:
// the same fields, the same broken-row policy (stray_cr, quote_junk, unterminated_quote, short_row, long_row),
// the same error order. Where the reference builds each field a character at a time, this reader scans with
// charCodeAt, cuts fields out of the text with slice, and gives a whole plain record — no quote and no stray CR
// before its line break — one indexOf-driven pass. The broken paths are walked exactly as the reference walks
// them, only when a quote, a CR or an error is actually met.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to the next.

// How a field ended: at a comma (the record goes on), at a line break, or at the end of the text.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = typeof input.text === 'string' ? input.text : String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Set once an indexOf finds no more of its character in this text: the plain-record pass may then skip asking.
  let quotesGone = false;
  let crGone = false;

  // Reads unquoted characters onto `prefix` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Returns [value, ended]. The plain scan is one tight loop; only a stray CR makes it
  // collect the field in slices, so the kept characters are the slices between the dropped CRs.
  function readUnquoted(prefix) {
    const start = pos;
    let segStart = pos;
    let parts = null;
    let p = pos;
    let ended = END;
    scan: for (;;) {
      if (p >= len) {
        ended = END;
        pos = p;
        break scan;
      }
      const c = text.charCodeAt(p);
      if (c === 44) {
        ended = COMMA;
        pos = p + 1;
        break scan;
      }
      if (c === 10) {
        ended = LINE_BREAK;
        pos = p + 1;
        line += 1;
        break scan;
      }
      if (c === 13) {
        if (text.charCodeAt(p + 1) === 10) {
          ended = LINE_BREAK;
          pos = p + 2;
          line += 1;
          break scan;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = prefix === '' ? [] : [prefix];
        parts.push(text.slice(segStart, p));
        p += 1;
        segStart = p;
        continue;
      }
      p += 1;
    }
    if (parts === null) {
      return [prefix === '' ? text.slice(start, p) : prefix + text.slice(start, p), ended];
    }
    parts.push(text.slice(segStart, p));
    return [parts.join(''), ended];
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let p = open + 1;
    let segStart = p;
    let parts = null;
    let closed = false;
    while (p < len) {
      const c = text.charCodeAt(p);
      if (c === 34) {
        if (text.charCodeAt(p + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(segStart, p), '"');
          p += 2;
          segStart = p;
          continue;
        }
        closed = true;
        break;
      }
      if (c === 13) {
        // CRLF and a lone CR inside quotes are each one LF.
        if (parts === null) parts = [];
        parts.push(text.slice(segStart, p), '\n');
        line += 1;
        p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
        segStart = p;
        continue;
      }
      if (c === 10) line += 1;
      p += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    let value;
    if (parts === null) {
      value = text.slice(open + 1, p);
    } else {
      parts.push(text.slice(segStart, p));
      value = parts.join('');
    }
    pos = p + 1;
    if (pos >= len) return [value, END];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK];
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk[0].length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;
    let quoted = false;

    // The plain-record pass: when no quote and no CR stands before the record's line break (the CR of a CRLF
    // ending aside), the record is fields of plain text and one split reads it whole.
    const nl = text.indexOf('\n', pos);
    if (nl !== -1) {
      let quoteIn = false;
      if (!quotesGone) {
        const q = text.indexOf('"', pos);
        if (q === -1) quotesGone = true;
        else quoteIn = q < nl;
      }
      if (!quoteIn) {
        const contentEnd = text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        let crIn = false;
        if (!crGone) {
          const r = text.indexOf('\r', pos);
          if (r === -1) crGone = true;
          else crIn = r < contentEnd;
        }
        if (!crIn) {
          fields = text.slice(pos, contentEnd).split(',');
          line += 1;
          pos = nl + 1;
        }
      }
    }

    if (fields === null) {
      fields = [];
      let ended;
      do {
        quoted = text.charCodeAt(pos) === 34;
        const field = quoted ? readQuoted() : readUnquoted('');
        fields.push(field[0]);
        ended = field[1];
      } while (ended === COMMA);
      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    } else if (fields.length === 1 && fields[0] === '') {
      // A plain pass over one empty field cannot arise (the line above was not empty); kept for symmetry.
      continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
