// 公開ページ（index / help / privacy-policy / terms-of-service）の表示言語切替。
// 拡張本体の i18n（src/_locales。ja / en の 2 言語）に合わせ、ページも「併記」ではなく
// 「切替」で 1 言語だけを表示する。
//
// 仕組み:
//   - 本文は .ja / .en の対で両言語を持ち、表示・非表示は CSS（html[data-lang]）が行う
//   - <title> / meta description のようなテキストは data-en、alt / aria-label のような
//     属性は data-en-<属性名> に英語を持たせ、本スクリプトが差し替える（元の ja は
//     初回に data-ja / data-ja-<属性名> へ退避する）
//   - 言語は ?lang= → localStorage → ブラウザの言語設定 → ja の順で解決する
//   - JS が無効な環境では data-lang が付かないため、従来どおり両言語が並ぶ（degrade）
//
// ビルド対象外の素の JS（GitHub Pages へそのまま配置する）。head から同期読み込みし、
// 最初の描画より前に data-lang を確定させる（切替のちらつきを避けるため）。
//
// version: 2026-08-07
(function () {
  'use strict';

  var STORAGE_KEY = 'sr-query-builder-plugin.lang';
  var DEFAULT_LANGUAGE = 'ja';
  var LANGUAGES = ['ja', 'en'];
  var BUTTON_LABELS = { ja: '日本語', en: 'English' };
  var SWITCH_LABELS = { ja: '表示言語', en: 'Language' };
  // 言語別に差し替える属性（data-en-<属性名> を持つ要素だけが対象）
  var LOCALIZED_ATTRIBUTES = ['content', 'alt', 'title', 'aria-label'];

  function isLanguage(value) {
    return LANGUAGES.indexOf(value) !== -1;
  }

  function languageFromQuery() {
    var match = /[?&]lang=([^&]*)/.exec(window.location.search);
    if (!match) {
      return null;
    }
    try {
      return decodeURIComponent(match[1]);
    } catch (error) {
      return null;
    }
  }

  function languageFromStorage() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      // プライベートモード等でストレージが使えない場合は無視する
      return null;
    }
  }

  function persistLanguage(language) {
    try {
      window.localStorage.setItem(STORAGE_KEY, language);
    } catch (error) {
      // 保存できなくても表示自体は成立するため無視する
    }
  }

  function languageFromNavigator() {
    var tags =
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language || ''];
    for (var i = 0; i < tags.length; i += 1) {
      var tag = String(tags[i]).toLowerCase();
      for (var j = 0; j < LANGUAGES.length; j += 1) {
        if (tag.indexOf(LANGUAGES[j]) === 0) {
          return LANGUAGES[j];
        }
      }
    }
    return null;
  }

  function resolveLanguage() {
    var fromQuery = languageFromQuery();
    if (isLanguage(fromQuery)) {
      // 明示指定（拡張本体からの遷移・共有リンク）は以後の既定として覚える
      persistLanguage(fromQuery);
      return fromQuery;
    }
    var fromStorage = languageFromStorage();
    if (isLanguage(fromStorage)) {
      return fromStorage;
    }
    return languageFromNavigator() || DEFAULT_LANGUAGE;
  }

  /** data-en を持つ要素の textContent を切り替える（<title> など） */
  function localizeText(language) {
    var nodes = document.querySelectorAll('[data-en]');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.getAttribute('data-ja') === null) {
        node.setAttribute('data-ja', node.textContent);
      }
      node.textContent = node.getAttribute('data-' + language);
    }
  }

  /** data-en-<属性名> を持つ要素の属性値を切り替える（alt / aria-label など） */
  function localizeAttributes(language) {
    for (var a = 0; a < LOCALIZED_ATTRIBUTES.length; a += 1) {
      var attribute = LOCALIZED_ATTRIBUTES[a];
      var nodes = document.querySelectorAll('[data-en-' + attribute + ']');
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        var backup = 'data-ja-' + attribute;
        if (node.getAttribute(backup) === null) {
          node.setAttribute(backup, node.getAttribute(attribute) || '');
        }
        node.setAttribute(attribute, node.getAttribute('data-' + language + '-' + attribute));
      }
    }
  }

  /** ?lang= を現在の言語に合わせる（この URL をコピーしても同じ言語で開ける） */
  function syncUrl(language) {
    if (!window.history || !window.history.replaceState) {
      return;
    }
    try {
      var url = new URL(window.location.href);
      url.searchParams.set('lang', language);
      window.history.replaceState(null, '', url.toString());
    } catch (error) {
      // URL を書き換えられない環境（file:// 等）では表示だけ切り替える
    }
  }

  /** [data-lang-switch] の中に言語切替ボタンを組み立てる（JS 前提の UI なので DOM 生成） */
  function buildSwitches() {
    var hosts = document.querySelectorAll('[data-lang-switch]');
    for (var i = 0; i < hosts.length; i += 1) {
      var host = hosts[i];
      if (host.getAttribute('data-lang-switch-ready') === 'true') {
        continue;
      }
      host.setAttribute('data-lang-switch-ready', 'true');
      host.setAttribute('role', 'group');
      for (var j = 0; j < LANGUAGES.length; j += 1) {
        host.appendChild(createButton(LANGUAGES[j]));
      }
    }
  }

  function createButton(target) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'lang-switch__button';
    button.setAttribute('data-lang-choice', target);
    button.setAttribute('lang', target);
    button.textContent = BUTTON_LABELS[target];
    button.addEventListener('click', function () {
      select(target);
    });
    return button;
  }

  function updateSwitches(language) {
    var hosts = document.querySelectorAll('[data-lang-switch]');
    for (var i = 0; i < hosts.length; i += 1) {
      hosts[i].setAttribute('aria-label', SWITCH_LABELS[language]);
    }
    var buttons = document.querySelectorAll('[data-lang-choice]');
    for (var j = 0; j < buttons.length; j += 1) {
      var button = buttons[j];
      var active = button.getAttribute('data-lang-choice') === language;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function apply(language) {
    var root = document.documentElement;
    root.setAttribute('lang', language);
    root.setAttribute('data-lang', language);
    localizeText(language);
    localizeAttributes(language);
    buildSwitches();
    updateSwitches(language);
  }

  function select(language) {
    persistLanguage(language);
    apply(language);
    syncUrl(language);
  }

  // 1 回目は head の時点（body 未パース）で <html> と <title> を確定させ、
  // 2 回目の DOMContentLoaded で本文側の属性・切替ボタンを整える
  var current = resolveLanguage();
  apply(current);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      apply(current);
    });
  }
})();
