// 公開ヘルプを言語別の小節データに変換する純関数と webpack ローダー。
function attribute(tag, name) {
  return new RegExp('\\b' + name + '\\s*=\\s*["\x27]([^"\x27]*)["\x27]', 'i').exec(tag)?.[1];
}

function hasClass(tag, name) {
  return (attribute(tag, 'class') ?? '').split(/\s+/).includes(name);
}

function filterSpans(html, lang) {
  const stack = [];
  let hidden = 0;
  let cursor = 0;
  let result = '';
  for (const match of html.matchAll(/<\/?span\b[^>]*>/gi)) {
    if (hidden === 0) {
      result += html.slice(cursor, match.index);
    }
    if (/^<\/span/i.test(match[0])) {
      if (stack.pop()) {
        hidden--;
      }
    } else {
      const hide = hasClass(match[0], lang === 'ja' ? 'en' : 'ja');
      stack.push(hide);
      if (hide) {
        hidden++;
      }
    }
    cursor = match.index + match[0].length;
  }
  if (hidden === 0) {
    result += html.slice(cursor);
  }
  return result;
}

function plainText(html, lang) {
  const entities = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
    copy: '©', reg: '®', times: '×', bull: '•', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  };
  return filterSpans(html, lang).replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
      if (entity.startsWith('#')) {
        const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
      }
      return entities[entity] ?? whole;
    })
    .replace(/https?:\/\/[^\s<>"'）)]+/gi, '')
    .replace(/\s+/g, ' ').trim();
}

function parseHelpSections(html, lang) {
  if (lang !== 'ja' && lang !== 'en') {
    throw new Error('ヘルプの言語は ja または en を指定してください');
  }
  const source = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const result = [];
  for (const section of source.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section\s*>/gi)) {
    const sectionId = attribute(section[1], 'id');
    if (!sectionId) {
      continue;
    }
    const content = section[2];
    const h2 = /<h2\b[^>]*>([\s\S]*?)<\/h2\s*>/i.exec(content);
    const sectionTitle = plainText(h2?.[1] ?? '', lang);
    const add = (id, kind, title, body) => {
      const when = [];
      body = body.replace(/<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi, (whole, attrs, inner) => {
        if (!hasClass(attrs, 'help-when')) {
          return whole;
        }
        when.push(...[...inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map(item => plainText(item[1], lang)));
        return '';
      });
      body = body.replace(/<p\b([^>]*)>[\s\S]*?<\/p\s*>/gi, (whole, attrs) => hasClass(attrs, 'chapter-video') ? '' : whole);
      result.push({ id, kind, sectionId, sectionTitle, title: plainText(title, lang), when, body: plainText(body, lang) });
    };
    if (sectionId === 'troubleshooting') {
      const headings = [...content.matchAll(/<h3\b([^>]*)>([\s\S]*?)<\/h3\s*>/gi)];
      for (let index = 0; index < headings.length; index++) {
        const heading = headings[index];
        const id = attribute(heading[1], 'id');
        if (id) {
          add(id, 'troubleshooting', heading[2], content.slice(heading.index + heading[0].length, headings[index + 1]?.index));
        }
      }
    } else if (sectionId === 'faq') {
      for (const details of content.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details\s*>/gi)) {
        const id = attribute(details[1], 'id');
        const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(details[2]);
        if (id && hasClass(details[1], 'faq') && summary) {
          add(id, 'faq', summary[1], details[2].slice(summary.index + summary[0].length));
        }
      }
    } else if (h2 && !/<h3\b/i.test(content) && !/<details\b[^>]*class=["'][^"']*\bfaq\b/i.test(content)) {
      add(sectionId, 'section', h2[1], content.slice(h2.index + h2[0].length));
    }
  }
  return result;
}

module.exports = function (source) {
  const lang = new URLSearchParams(this.resourceQuery.slice(1)).get('lang');
  return 'module.exports = ' + JSON.stringify(parseHelpSections(source, lang)) + ';';
};
module.exports.parseHelpSections = parseHelpSections;
