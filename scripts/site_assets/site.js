// Front-page filtering for the generated keyword reference.
//
// The full keyword list is server-rendered, so the page works without this
// script; all we do here is hide rows that do not match. Matching runs against
// each row's own text, which already contains the name, sections and summary —
// no extra payload to download.

(function () {
  'use strict';

  var search = document.getElementById('kw-search');
  var count = document.getElementById('kw-count');
  var empty = document.getElementById('kw-empty');
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.letter-group'));
  var rows = Array.prototype.slice.call(document.querySelectorAll('li.kw'));

  if (!search || rows.length === 0) return;

  var haystack = rows.map(function (row) {
    return row.textContent.toLowerCase();
  });
  var section = 'ALL';

  function apply() {
    var needle = search.value.trim().toLowerCase();
    var shown = 0;

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var okSection = section === 'ALL' ||
        row.dataset.s.indexOf(' ' + section + ' ') !== -1;
      var okText = needle === '' || haystack[i].indexOf(needle) !== -1;
      var visible = okSection && okText;
      row.hidden = !visible;
      if (visible) shown++;
    }

    for (var g = 0; g < groups.length; g++) {
      groups[g].hidden = !groups[g].querySelector('li.kw:not([hidden])');
    }

    count.textContent = shown === rows.length
      ? rows.length + ' keywords'
      : shown + ' of ' + rows.length + ' keywords';
    empty.hidden = shown !== 0;
  }

  search.addEventListener('input', apply);

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      section = chip.dataset.section;
      chips.forEach(function (other) {
        other.classList.toggle('is-active', other === chip);
      });
      apply();
    });
  });

  apply();
})();
