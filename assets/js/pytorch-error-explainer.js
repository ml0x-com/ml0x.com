/* PyTorch error explainer: client-side regex rules. Nothing you paste leaves the browser.
   Each rule matches an error string, adds a line with your own numbers, and shows the
   cause and fix from the matching <section id="e-<rule>"> on this page. */
(function () {
  'use strict';
  function nums(s) { return (s || '').split(/\s*,\s*/).filter(Boolean).map(Number); }
  function prod(a) { return a.reduce(function (x, y) { return x * y; }, 1); }
  function gib(v, u) { v = parseFloat(v); u = (u || '').toUpperCase(); return u[0] === 'M' ? v / 1024 : u[0] === 'K' ? v / 1048576 : v; }
  function f2(x) { return (Math.round(x * 100) / 100).toString(); }

  // Order matters: specific rules first, generic fallbacks last. A paste can match more than one rule.
  var RULES = [
    { id: 'mat1-mat2', re: /mat1 and mat2 shapes cannot be multiplied \((\d+)x(\d+) and (\d+)x(\d+)\)/, spec: function (m) {
      var a = +m[1], b = +m[2], c = +m[3], d = +m[4];
      var s = 'Your input has ' + b + ' features per row (' + a + ' rows), but the layer expects in_features=' + c + ' and outputs ' + d + '. Fix: nn.Linear(' + b + ', ' + d + '), or nn.LazyLinear(' + d + ').';
      if (b > c && b % c === 0) s += ' The input is exactly ' + (b / c) + 'x larger than expected: check the image size or the number of channels before the flatten.';
      else if (c > b && c % b === 0) s += ' The layer expects ' + (c / b) + 'x more features than arrive: a pooling or stride step may be shrinking the feature map more than you assumed.';
      return s; } },
    { id: 'broadcast', re: /The size of tensor a \((\d+)\) must match the size of tensor b \((\d+)\) at non-singleton dimension (\d+)/, spec: function (m) {
      return 'At dimension ' + m[3] + ', one tensor has ' + m[1] + ' and the other has ' + m[2] + '. Neither is 1, so they cannot broadcast. Print both shapes on the failing line.'; } },
    { id: 'cat', re: /Sizes of tensors must match except in dimension (\d+)\. (?:Expected size (\d+) but got size (\d+) for tensor number (\d+)|Got (\d+) and (\d+) in dimension (\d+))/, spec: function (m) {
      if (m[2]) {
        var diff = Math.abs(+m[2] - +m[3]);
        return 'You are joining along dimension ' + m[1] + '. Tensor number ' + m[4] + ' has size ' + m[3] + ' where the first has ' + m[2] + ' (off by ' + diff + ').' + (diff <= 2 ? ' An off-by-one or two is the classic U-Net rounding problem: resize the upsampled map to the skip connection.' : '');
      }
      return 'You are joining along dimension ' + m[1] + ', but dimension ' + m[7] + ' has sizes ' + m[5] + ' and ' + m[6] + '.'; } },
    { id: 'stack', re: /stack expects each tensor to be equal size, but got \[([\d, ]*)\] at entry (\d+) and \[([\d, ]*)\] at entry (\d+)/, spec: function (m) {
      var a = nums(m[1]), b = nums(m[3]);
      var s = 'Entry ' + m[2] + ' is [' + a.join(', ') + '] and entry ' + m[4] + ' is [' + b.join(', ') + '].';
      if (a.length === 3 && b.length === 3 && a[0] !== b[0] && a[1] === b[1] && a[2] === b[2]) s += ' Only the channel count differs (' + a[0] + ' vs ' + b[0] + '): one image is grayscale or RGBA. Use .convert("RGB").';
      else if (a.length === 3 && b.length === 3) s += ' Spatial sizes differ: add a Resize or crop to the transform.';
      return s; } },
    { id: 'conv-channels', re: /weight of size \[([\d, ]+)\], expected input\[([\d, ]+)\] to have (\d+) channels, but got (\d+) channels instead/, spec: function (m) {
      var inp = nums(m[2]), want = +m[3], got = +m[4];
      var s = 'The layer expects ' + want + ' input channels and got ' + got + ' (input shape [' + inp.join(', ') + ']).';
      if (inp.length >= 3 && inp[inp.length - 1] === want) s += ' The last dimension is ' + want + ', so the tensor is channels-last: use x.permute(0, ' + (inp.length === 4 ? '3, 1, 2' : '2, 1') + ').';
      else if (want === 3 && got === 1) s += ' Grayscale into an RGB layer: x.repeat(1, 3, 1, 1) or in_channels=1.';
      else if (want === 3 && got === 4) s += ' Four channels is RGBA: .convert("RGB") when loading.';
      return s; } },
    { id: 'conv-rank', re: /Expected (\d)D \(unbatched\) or (\d)D \(batched\) input to (\w+), but got input of size: \[([\d, ]*)\]/, spec: function (m) {
      var shp = nums(m[4]);
      var s = m[3] + ' wants ' + m[1] + 'D or ' + m[2] + 'D input; yours is ' + shp.length + 'D [' + shp.join(', ') + '].';
      if (shp.length < +m[1]) s += ' Add the missing dimension(s) with unsqueeze.';
      else if (shp.length > +m[2]) s += ' There is an extra dimension; squeeze it or fix how the batch is built.';
      return s; } },
    { id: 'batch-size', re: /Expected input batch_size \((\d+)\) to match target batch_size \((\d+)\)/, spec: function (m) {
      var a = +m[1], b = +m[2];
      var s = 'The model produced ' + a + ' rows for ' + b + ' targets.';
      if (a > b && a % b === 0) s += ' That is exactly ' + (a / b) + 'x: a view/reshape merged the batch with another dimension. Use torch.flatten(x, 1).';
      else if (b > a && b % a === 0) s += ' Targets are ' + (b / a) + 'x more: flatten the logits the same way as the targets (sequence models).';
      return s; } },
    { id: 'ce-target', re: /Expected target size \[([\d, ]+)\], got \[([\d, ]+)\]/, spec: function (m) {
      return 'The loss wanted a target shaped [' + m[1] + '] and got [' + m[2] + ']. Your logits have the class axis last; move it to dimension 1 or flatten both.'; } },
    { id: 'multi-target', re: /(?:0D or )?1D target tensor expected, multi-target not supported/, spec: function () {
      return 'Your labels have more than one dimension. CrossEntropyLoss wants class indices shaped (N,).'; } },
    { id: 'bce-target', re: /(?:Target|Using a target) size \(torch\.Size\(\[([\d, ]*)\]\)\) (?:must be the same as|that is different to the) input size \(torch\.Size\(\[([\d, ]*)\]\)\)/, spec: function (m) {
      return 'Target shape [' + m[1] + '], prediction shape [' + m[2] + ']. Make them identical, usually with logits.squeeze(-1).'; } },
    { id: 'view-invalid', re: /shape '\[([-\d, ]+)\]' is invalid for input of size (\d+)/, spec: function (m) {
      var shp = nums(m[1]), n = +m[2], known = prod(shp.filter(function (x) { return x !== -1; }));
      var s = 'You asked for [' + shp.join(', ') + '] from ' + n + ' elements.';
      if (shp.indexOf(-1) >= 0) s += ' The fixed dimensions multiply to ' + known + (n % known ? ', and ' + n + ' / ' + known + ' = ' + f2(n / known) + ', not a whole number.' : '.');
      else s += ' That shape holds ' + prod(shp) + ' elements, not ' + n + '.';
      if (shp.length && shp[0] > 0 && n % shp[0] !== 0) s += ' A hard-coded first dimension (' + shp[0] + ') is the usual suspect, often on the last smaller batch.';
      return s; } },
    { id: 'view-stride', re: /view size is not compatible with input tensor's size and stride/, spec: function () {
      return 'Use .reshape(...) or call .contiguous() before .view(...).'; } },
    { id: 'expand', re: /The expanded size of the tensor \((-?\d+)\) must match the existing size \((\d+)\) at non-singleton dimension (\d+)/, spec: function (m) {
      return 'Dimension ' + m[3] + ' has size ' + m[2] + ' and you asked for ' + m[1] + '. Only size-1 dimensions can be expanded.'; } },
    { id: 'state-dict', re: /size mismatch for ([\w.]+): copying a param with shape torch\.Size\(\[([\d, ]*)\]\) from checkpoint, the shape in current model is torch\.Size\(\[([\d, ]*)\]\)/g, all: true, spec: function (ms) {
      var lines = ms.slice(0, 6).map(function (m) { return m[1] + ': checkpoint [' + m[2] + '] vs model [' + m[3] + ']'; });
      var s = ms.length + ' mismatched parameter(s). ' + lines.join('; ') + (ms.length > 6 ? '; ...' : '') + '.';
      var heads = ms.filter(function (m) { return /(fc|head|classifier|lm_head|out|embed)/i.test(m[1]); }).length;
      if (heads === ms.length) s += ' Only head or embedding layers differ: load the backbone and replace the head.';
      return s; } },
    { id: 'dim-range', re: /Dimension out of range \(expected to be in range of \[(-?\d+), (-?\d+)\], but got (-?\d+)\)/, spec: function (m) {
      return 'The tensor has ' + (+m[2] + 1) + ' dimension(s), and the code asked for dimension ' + m[3] + '.'; } },
    { id: 'rnn-input', re: /input\.size\(-1\) must be equal to input_size\. Expected (\d+), got (\d+)/, spec: function (m) {
      return 'The recurrent layer was built for ' + m[1] + ' features; the last dimension of your input is ' + m[2] + '.'; } },
    { id: 'mha-embed', re: /was expecting embedding dimension of (\d+), but got (\d+)/, spec: function (m) {
      return 'The attention layer has embed_dim ' + m[1] + '; your query has ' + m[2] + ' in its last dimension.'; } },
    { id: 'broadcast-shape', re: /output with shape \[([\d, ]*)\] doesn't match the broadcast shape \[([\d, ]*)\]/, spec: function (m) {
      var a = nums(m[1]), b = nums(m[2]);
      var s = 'An in-place op cannot grow [' + a.join(', ') + '] to [' + b.join(', ') + '].';
      if (a[0] === 1 && b[0] === 3) s += ' 1 vs 3 channels: a grayscale image is meeting 3-channel Normalize values.';
      return s; } },
    { id: 'device', re: /Expected all tensors to be on the same device, but (?:found at least two devices, ([\w:]+) and ([\w:]+)|got (\w+) is on ([\w:]+), different from other tensors on ([\w:]+))/, spec: function (m) {
      var a = m[1] || m[4], b = m[2] || m[5];
      return 'One operation mixes ' + a + ' and ' + b + '. Find the tensor created without device=... or the batch you did not move.'; } },
    { id: 'input-weight-type', re: /Input type \(([\w.]+)\) and weight type \(([\w.]+)\) should be the same/, spec: function (m) {
      var ca = /cuda|mps/.test(m[1]), cb = /cuda|mps/.test(m[2]);
      if (ca !== cb) return 'Device mismatch: input is ' + m[1] + ', weights are ' + m[2] + '. Move the input to the model\'s device.';
      return 'Dtype mismatch: input is ' + m[1] + ', weights are ' + m[2] + '. Cast the input, or use torch.autocast.'; } },
    { id: 'dtype', re: /expected (?:scalar type|m1 and m2 to have the same dtype, but got:?) ?(\w+)(?: but found| !=) (\w+)|mat1 and mat2 must have the same dtype(?:, but got (\w+) and (\w+))?|expected both vectors to have same dtype/, spec: function (m) {
      var a = m[1] || m[3], b = m[2] || m[4];
      if (!a) return 'Two tensors in one operation have different dtypes.';
      var s = 'One tensor is ' + a + ', the other is ' + b + '.';
      if (/Double/.test(a + b) && /Float/.test(a + b)) s += ' Double usually comes from NumPy: add .float() where you convert.';
      if (/Half|BFloat16/.test(a + b)) s += ' Half/BFloat16 against Float: use torch.autocast rather than casting single tensors.';
      if (/Long/.test(a + b)) s += ' Long against Float: labels or indices reached a float op (or the reverse).';
      return s; } },
    { id: 'cuda-oom', re: /(CUDA|MPS backend) out of memory/, spec: function (m, text) {
      var s = '', t = /Tried to allocate ([\d.]+) ([GMK]i?B)/.exec(text);
      var tot = /([\d.]+) ([GMK]i?B) total capacity|total capacity of ([\d.]+) ([GMK]i?B)/.exec(text);
      var alloc = /([\d.]+) ([GMK]i?B) (?:already allocated|is allocated by PyTorch)/.exec(text);
      var frag = /([\d.]+) ([GMK]i?B) is reserved by PyTorch but unallocated/.exec(text);
      var free = /([\d.]+) ([GMK]i?B) free|of which ([\d.]+) ([GMK]i?B) is free/.exec(text);
      if (m[1] === 'MPS backend') s += 'Apple GPU (MPS) memory. ';
      if (t) s += 'The failed request was ' + t[1] + ' ' + t[2] + '. ';
      if (tot) s += 'GPU total ' + (tot[1] || tot[3]) + ' ' + (tot[2] || tot[4]) + '. ';
      if (alloc) s += 'PyTorch had ' + alloc[1] + ' ' + alloc[2] + ' allocated. ';
      if (free) s += 'Free: ' + (free[1] || free[3]) + ' ' + (free[2] || free[4]) + '. ';
      if (frag && t && gib(frag[1], frag[2]) >= Math.min(0.5, gib(t[1], t[2]))) s += frag[1] + ' ' + frag[2] + ' is reserved but unallocated, which points to fragmentation: try PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True. ';
      if (tot && alloc) {
        var share = gib(alloc[1], alloc[2]) / gib(tot[1] || tot[3], tot[2] || tot[4]);
        if (share < 0.5) s += 'PyTorch itself uses under half the GPU: another process (nvidia-smi) holds the rest. ';
      }
      return s || 'The GPU ran out of memory.'; } },
    { id: 'index-range', re: /index out of range in self/, spec: function () {
      return 'An index reached past the end of an embedding or lookup table. Compare ids.max() with num_embeddings.'; } },
    { id: 'device-assert', re: /device-side assert triggered/, spec: function () {
      return 'The real error is hidden. Re-run with CUDA_LAUNCH_BLOCKING=1, or on the CPU, to see it.'; } },
    // Generic fallbacks, only used when nothing more specific matched.
    { id: 'expected-dim', generic: true, re: /(?:got (?:input )?(?:tensor )?dim(?:ension)?\D{0,20}(\d+)\D{1,40}expected (?:dim(?:ension)?)?\D{0,10}(\d+))|(?:expected (?:input )?(?:tensor )?dim(?:ension)?\D{0,20}(\d+)\D{1,40}got\D{0,20}(\d+))/i, spec: function (m) {
      var got = m[1] || m[4], exp = m[2] || m[3];
      return 'Expected ' + exp + ', got ' + got + ' in a feature dimension.' + (got && exp && (+got % +exp === 0 || +exp % +got === 0) ? ' One is a multiple of the other (' + f2(Math.max(+got, +exp) / Math.min(+got, +exp)) + 'x): check heads x head_dim, channels or an un-flattened axis.' : ''); } },
    { id: 'expected-size', generic: true, re: /(?:does not|doesn't|do not) match (?:the )?expected (?:size|shape)|expected (?:size|shape)\D{0,20}\d+\D{1,30}(?:got|but)/i, spec: function (m, text) {
      var n = (text.match(/\d+/g) || []).slice(0, 6);
      return n.length ? 'Numbers in your message: ' + n.join(', ') + '. Compare them pairwise to find the dimension that differs.' : 'A shape check failed.'; } }
  ];

  var box = document.getElementById('err'), out = document.getElementById('result'), btn = document.getElementById('explain');
  if (!box || !out) return;
  var lastTracked = '';

  function render() {
    var text = box.value || '';
    out.textContent = '';
    if (!text.trim()) return;
    var hits = [];
    RULES.forEach(function (r) {
      if (r.generic && hits.length) return;
      if (r.all) {
        var ms = [], mm; r.re.lastIndex = 0;
        while ((mm = r.re.exec(text))) ms.push(mm);
        if (ms.length) hits.push({ r: r, spec: r.spec(ms, text) });
        return;
      }
      var m = r.re.exec(text);
      if (m) hits.push({ r: r, spec: r.spec(m, text) });
    });
    if (!hits.length) {
      var p = document.createElement('div');
      p.className = 'card';
      p.innerHTML = '<h2>No rule matched</h2><p>The explainer knows the shape, dtype, device and memory errors listed below. Paste the whole last line of the traceback, including the numbers. If your error is not covered, the list below may still help.</p>';
      out.appendChild(p);
      track('none');
      return;
    }
    hits.slice(0, 3).forEach(function (h) {
      var sec = document.getElementById('e-' + h.r.id);
      var card = document.createElement('div');
      card.className = 'card result';
      var t = document.createElement('h2');
      t.textContent = sec ? sec.getAttribute('data-name') : h.r.id;
      card.appendChild(t);
      var y = document.createElement('p');
      y.className = 'yours';
      y.textContent = h.spec;
      card.appendChild(y);
      if (sec) {
        var body = sec.querySelector('.body');
        if (body) card.appendChild(body.cloneNode(true));
      }
      out.appendChild(card);
    });
    var pf = document.getElementById(hits[0].r.id === 'cuda-oom' ? 'cta-oom' : 'cta-preflight');
    if (pf) { var c = pf.cloneNode(true); c.removeAttribute('id'); c.hidden = false; out.appendChild(c); if (window.__l4watch) window.__l4watch(c); }
    track(hits.map(function (h) { return h.r.id; }).join(','));
  }
  function track(ids) {
    if (ids === lastTracked) return;
    lastTracked = ids;
    try { if (typeof window.mrTrack === 'function') window.mrTrack('error_explained', { site: 'ml0x.com', rule: ids.slice(0, 100) }); } catch (e) {}
  }
  var timer;
  box.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(render, 250); });
  if (btn) btn.addEventListener('click', function (e) { e.preventDefault(); render(); out.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  document.querySelectorAll('[data-example]').forEach(function (a) {
    a.addEventListener('click', function (e) { e.preventDefault(); box.value = a.getAttribute('data-example'); render(); });
  });
  window.__pyErrRules = RULES; // exposed for tests
})();
