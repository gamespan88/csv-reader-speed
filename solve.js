// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader), written for the csv-reader-speed-01 bounty.
// run(input) returns exactly csv-reader's reading of {text, header} — {columns, rows, errors} — for every input:
// the same fields, the same broken-row policy (stray_cr, quote_junk, unterminated_quote, short_row, long_row),
// the same error order. Version 2: where version 1 walked the field-by-field path a character at a time, this
// reader hops with indexOf everywhere — plain records split whole, unquoted fields end at the nearest comma or
// line break found by indexOf, quoted fields hop from quote to quote — and keeps the next quote / CR / LF
// positions cached so no scan is ever repeated. The character walks remain for the fields that truly need
// them: one holding a stray CR, one whose quoted text holds a line break. A field read through the fast hops
// and one read through the walk answer the same, always.
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

  // The next quote / CR / LF positions, cached: an indexOf result is never scanned for twice. -1: none in
  // the rest of the text. A cached index left behind by pos is stale and is refreshed from the new position
  // before it is believed. The one place pos ever jumps backwards is the unterminated-quote re-read, which
  // therefore throws all three caches away.
  let nextQuote = -2;
  let nextCR = -2;
  let nextLF = -2;

  function quoteFrom(p) {
    if (nextQuote === -2 || (nextQuote !== -1 && nextQuote < p)) nextQuote = text.indexOf('"', p);
    return nextQuote;
  }
  function crFrom(p) {
    if (nextCR === -2 || (nextCR !== -1 && nextCR < p)) nextCR = text.indexOf('\r', p);
    return nextCR;
  }
  function lfFrom(p) {
    if (nextLF === -2 || (nextLF !== -1 && nextLF < p)) nextLF = text.indexOf('\n', p);
    return nextLF;
  }

  // The field just read, handed back through these two instead of a fresh array per field.
  let fv = '';
  let fe = END;

  // Reads unquoted characters onto `prefix` up to the next comma or line break, a character at a time: a CR
  // not followed by LF is dropped (stray_cr). Only a field that truly holds a stray CR is read this way.
  function readUnquotedWalk(prefix) {
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
      fv = prefix === '' ? text.slice(start, p) : prefix + text.slice(start, p);
    } else {
      parts.push(text.slice(segStart, p));
      fv = parts.join('');
    }
    fe = ended;
  }

  // Reads unquoted characters onto `prefix` up to the next comma or line break: the end is found with
  // indexOf, and only a CR standing inside the field (and not the CR of its closing CRLF) sends the field
  // to the character walk above.
  function readUnquoted(prefix) {
    const start = pos;
    const nc = text.indexOf(',', start);
    let nl = nextLF;
    if (nl === -2 || (nl !== -1 && nl < start)) {
      nl = text.indexOf('\n', start);
      nextLF = nl;
    }
    let end = len;
    let ended = END;
    if (nc !== -1 && (nl === -1 || nc < nl)) {
      end = nc;
      ended = COMMA;
    } else if (nl !== -1) {
      end = nl;
      ended = LINE_BREAK;
    }
    let r = nextCR;
    if (r === -2 || (r !== -1 && r < start)) {
      r = text.indexOf('\r', start);
      nextCR = r;
    }
    if (r !== -1 && r < end && !(ended === LINE_BREAK && r === end - 1)) {
      readUnquotedWalk(prefix);
      return;
    }
    let valueEnd = end;
    if (ended === COMMA) {
      pos = end + 1;
    } else if (ended === LINE_BREAK) {
      if (end > start && text.charCodeAt(end - 1) === 13) valueEnd = end - 1;
      pos = end + 1;
      line += 1;
    } else {
      pos = end;
    }
    fv = prefix === '' ? text.slice(start, valueEnd) : prefix + text.slice(start, valueEnd);
    fe = ended;
  }

  // The quoted segment text[p..q) with each CRLF and lone CR in it read as one LF (and counted as one line).
  // A segment holding LFs but no CR keeps its text as it stands — only the lines are counted, by indexOf
  // hops; one holding a CR is walked a character at a time, cutting only at the CRs. Returns its value.
  function quotedSegment(p, q) {
    let cr = nextCR;
    if (cr === -2 || (cr !== -1 && cr < p)) {
      cr = text.indexOf('\r', p);
      nextCR = cr;
    }
    if (cr === -1 || cr >= q) {
      let n = 0;
      let i = p;
      for (;;) {
        i = text.indexOf('\n', i);
        if (i === -1 || i >= q) break;
        n += 1;
        i += 1;
      }
      line += n;
      nextLF = i;
      return text.slice(p, q);
    }
    const parts = [];
    let segStart = p;
    let i = p;
    while (i < q) {
      const c = text.charCodeAt(i);
      if (c === 13) {
        parts.push(text.slice(segStart, i), '\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        segStart = i;
        continue;
      }
      if (c === 10) line += 1;
      i += 1;
    }
    parts.push(text.slice(segStart, q));
    return parts.join('');
  }

  // Reads a quoted field whose opening quote is at pos, hopping from quote to quote.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let p = open + 1;
    let parts = null;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
        // pos jumps backwards to just after the opening quote — behind ground the cached positions were
        // scanned from — so all three caches are thrown away and the re-read scans afresh.
        pos = open + 1;
        line = openLine;
        nextQuote = -2;
        nextCR = -2;
        nextLF = -2;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      nextQuote = q;
      // The segment before this quote: a line break in it (an LF before it, or a CR before it) is counted
      // and read as LF; a clean segment is one slice.
      let lf = nextLF;
      if (lf === -2 || (lf !== -1 && lf < p)) {
        lf = text.indexOf('\n', p);
        nextLF = lf;
      }
      let cr = nextCR;
      if (cr === -2 || (cr !== -1 && cr < p)) {
        cr = text.indexOf('\r', p);
        nextCR = cr;
      }
      let seg;
      if ((lf !== -1 && lf < q) || (cr !== -1 && cr < q)) {
        seg = quotedSegment(p, q);
      } else {
        seg = text.slice(p, q);
      }
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [];
        parts.push(seg, '"');
        p = q + 2;
        continue;
      }
      // The closing quote.
      let value = seg;
      if (parts !== null) {
        parts.push(seg);
        value = parts.join('');
      }
      pos = q + 1;
      if (pos >= len) {
        fv = value;
        fe = END;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fv = value;
        fe = COMMA;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fv = value;
        fe = LINE_BREAK;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fv = value;
        fe = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next comma or line break.
      readUnquoted(value);
      if (fv.length > value.length) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return;
    }
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
    const nl = lfFrom(pos);
    if (nl !== -1) {
      const q = quoteFrom(pos);
      if (q === -1 || q >= nl) {
        const contentEnd = text.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
        const r = crFrom(pos);
        if (r === -1 || r >= contentEnd) {
          fields = text.slice(pos, contentEnd).split(',');
          line += 1;
          pos = nl + 1;
        }
      }
    }

    if (fields === null) {
      fields = [];
      do {
        quoted = text.charCodeAt(pos) === 34;
        if (quoted) readQuoted();
        else readUnquoted('');
        fields.push(fv);
      } while (fe === COMMA);
      // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
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
