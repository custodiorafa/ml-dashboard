/* Coletor da Inteligência de Mercado — ML Intelligence
   Roda no navegador, dentro de app.shoppingdeprecos.com.br (usuário logado),
   acionado pelo favorito "MI Coletar". Não usa IA: busca no Shopping de Preços,
   agrupa os anúncios em produtos e grava no Worker market-intel.
   Lista de buscas e regras de título vêm do Worker (GET /keywords).
   Chave: localStorage.mi_key deste site (o usuário cola uma vez). */
(function () {
  if (!/shoppingdeprecos\.com\.br$/.test(location.hostname)) { alert('Abra o Shopping de Preços (logado) e clique no favorito de novo.'); return; }
  if (window.__MIC && window.__MIC.rodando) { document.getElementById('mic-box').style.display = 'block'; return; }

  var MI = 'https://market-intel.rafael-custodio.workers.dev';
  var PAINEL = 'https://custodiorafa.github.io/ml-dashboard/';
  var C = window.__MIC = { rodando: false, parar: false };

  /* ── utilidades ───────────────────────────────────────────── */
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var num = function (s) { s = (s || '').replace(/[+R$\s]/g, '').replace(/\./g, '').replace(',', '.'); var v = parseFloat(s); return isNaN(v) ? 0 : v; };
  var norm = function (s) { return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  var brandKey = function (s) { return norm(s).replace(/ original| brasil| automotive parts| automotive/g, '').trim().toUpperCase().slice(0, 30); };
  var fmt = function (d) { return d.toISOString().slice(0, 10); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var k = function (v) { return 'R$ ' + (v >= 1e6 ? (v / 1e6).toFixed(2).replace('.', ',') + ' mi' : Math.round(v / 1000) + ' mil'); };
  var isTit = function (v) { return /^titanium/i.test(v || ''); };

  async function post(data) {
    for (var t = 0; t < 10; t++) {
      if (C.parar) throw new Error('PARADO');
      var ac = new AbortController(); var to = setTimeout(function () { ac.abort(); }, 90000);
      var r;
      try { r = await fetch('/concorrentes/ajax', { signal: ac.signal, method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: new URLSearchParams(data).toString() }); }
      catch (e) { clearTimeout(to); await sleep(3000); continue; }
      clearTimeout(to);
      if (r.status === 200) { var tx = await r.text(); if (/Refa[cç]a seu login/i.test(tx)) throw new Error('SESSAO_EXPIRADA'); return tx; }
      await sleep(r.status === 429 ? 8000 : 3000);
    }
    throw new Error('Shopping de Preços não respondeu');
  }
  async function mi(path, method, body) {
    var r = await fetch(MI + path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + localStorage.getItem('mi_key'), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    var j = await r.json().catch(function () { return null; });
    if (r.status === 401) throw new Error('CHAVE_RECUSADA');
    if (!r.ok) throw new Error('Worker ' + r.status);
    return j;
  }

  /* ── produtos: agrupa anúncios parecidos ──────────────────────
     Tira do título as palavras da própria busca e as genéricas; o que
     sobra (aplicação, medida, modelo) define o produto. Anúncios com
     tokens parecidos (Jaccard ≥ 0,45) viram o mesmo produto. */
  var GEN = ('de da do das dos e p para pra c com s sem em a o as os na no um uma kit jogo par peca pecas novo nova original ' +
    'caminhao caminhoes onibus linha pesada pesado qualidade premium alta reforcado reforcada universal frete gratis envio imediato ' +
    'pronta entrega promocao oferta unidade unidades pc pcs und cj conjunto modelo tipo marca compativel completo cam inst instalacao aplicacao serve ate linha nf garantia').split(' ');
  var ALIAS = { mercedes: 'mb', benz: 'mb', mbb: 'mb', 'mercedes-benz': 'mb', volkswagen: 'vw', vwm: 'vw', constellation: 'constel', delivery: 'deliv' };
  function tokens(titulo, extra) {
    var out = {};
    norm(titulo).replace(/[^a-z0-9/]+/g, ' ').split(' ').forEach(function (w) {
      if (!w) return;
      w = ALIAS[w] || w;
      w = w.replace(/^\/+|\/+$/g, '');
      if (w.length < 2) return;
      if (GEN.indexOf(w) >= 0 || extra[w]) return;
      out[w] = 1;
    });
    return Object.keys(out);
  }
  function jac(a, b) {
    if (!a.length || !b.length) return 0;
    var s = {}, i = 0; a.forEach(function (x) { s[x] = 1; }); b.forEach(function (x) { if (s[x]) i++; });
    return i / (a.length + b.length - i);
  }
  function agruparProdutos(L, kw, total) {
    var extra = {};
    norm(kw.termo).split(/\s+/).forEach(function (w) { extra[w] = 1; });
    (kw.must || []).forEach(function (m) { norm(m).replace(/[^a-z0-9]+/g, ' ').split(' ').forEach(function (w) { if (w.length > 2) extra[w] = 1; }); });
    var grupos = [];
    L.slice().sort(function (a, b) { return b.fat - a.fat; }).forEach(function (a) {
      var tk = tokens(a.titulo, extra), best = null, bs = 0;
      grupos.forEach(function (g) { var s = jac(tk, g.tk); if (s > bs) { bs = s; best = g; } });
      if (best && bs >= 0.45) { best.itens.push(a); tk.forEach(function (t) { best.cnt[t] = (best.cnt[t] || 0) + 1; }); }
      else { var g = { tk: tk, itens: [a], cnt: {} }; tk.forEach(function (t) { g.cnt[t] = 1; }); grupos.push(g); }
    });
    return grupos.map(function (g) {
      var it = g.itens, fat = 0, un = 0, vend = {}, fatFull = 0;
      it.forEach(function (a) {
        fat += a.fat; un += a.un; if (/full/i.test(a.envio)) fatFull += a.fat;
        var v = vend[a.vendedor] = vend[a.vendedor] || { vendedor: a.vendedor, cidade: a.cidade, fat: 0, un: 0, full: false, marcas: {} };
        v.fat += a.fat; v.un += a.un; if (/full/i.test(a.envio)) v.full = true; v.marcas[a.marca] = 1;
      });
      var vs = Object.keys(vend).map(function (x) { var v = vend[x]; v.share = fat ? v.fat / fat : 0; v.preco = v.un ? v.fat / v.un : 0; v.marcas = Object.keys(v.marcas).slice(0, 2); return v; })
        .sort(function (a, b) { return b.fat - a.fat; });
      var tit = vs.filter(function (v) { return isTit(v.vendedor); })[0] || null;
      var precos = it.filter(function (a) { return a.un >= 3; }).map(function (a) { return a.fat / a.un; }).sort(function (a, b) { return a - b; });
      var chave = Object.keys(g.cnt).sort(function (a, b) { return g.cnt[b] - g.cnt[a]; }).slice(0, 5);
      return {
        nome: it[0].titulo, chave: chave, fat: fat, un: un, share_mercado: total ? fat / total : 0,
        n_anuncios: it.length, n_vendedores: vs.length, full_share: fat ? fatFull / fat : 0,
        preco_medio: un ? fat / un : 0, preco_min: precos[0] || 0, preco_mediano: precos.length ? precos[Math.floor(precos.length / 2)] : 0,
        lider: vs[0] ? { vendedor: vs[0].vendedor, cidade: vs[0].cidade, fat: vs[0].fat, share: vs[0].share, preco: vs[0].preco, full: vs[0].full, marcas: vs[0].marcas } : null,
        titanium: tit ? { fat: tit.fat, un: tit.un, share: tit.share, preco: tit.preco, full: tit.full, pos: vs.indexOf(tit) + 1 } : null,
        vendedores: vs.slice(0, 5).map(function (v) { return { vendedor: v.vendedor, cidade: v.cidade, fat: v.fat, un: v.un, share: v.share, preco: v.preco, full: v.full, marcas: v.marcas }; }),
        anuncios: it.slice(0, 6).map(function (a) { return { titulo: a.titulo, vendedor: a.vendedor, marca: a.marca, envio: a.envio, un: a.un, fat: a.fat, mlb: a.mlb }; }),
      };
    }).sort(function (a, b) { return b.fat - a.fat; }).slice(0, 30);
  }

  /* ── coleta de uma busca ──────────────────────────────────── */
  async function coletar(kw, ini, fim) {
    var h = await post({ db_op: 'table_vendas_produtos_produto', titulo: kw.termo, ini: ini, fim: fim, favoritos: '0', catalogo: '', arrendodar_valor_total: 't' });
    var d = new DOMParser().parseFromString(h, 'text/html');
    var tb = d.getElementById('table_marca');
    var cats = tb ? [].slice.call(tb.rows, 1).filter(function (r) { return r.id; }).map(function (r) { return { id: r.id, rel: r.getAttribute('relatorio') || '', nome: (r.cells[1] || {}).textContent.trim(), tot: num((r.cells[3] || {}).textContent) }; }) : [];
    var totalBusca = cats.reduce(function (s, c) { return s + c.tot; }, 0);
    var minCat = Math.max(3000, totalBusca * 0.03);
    var items = [];
    var alvo = cats.filter(function (c) { return c.tot >= minCat; }).slice(0, 8);
    for (var ci = 0; ci < alvo.length; ci++) {
      var c = alvo[ci];
      for (var p = 0; p < 5; p++) {
        var hh = await post({ db_op: 'table_vendas_produtos_produto_itens', page: String(p * 30), col: 'total', dir: 'desc', titulo: kw.termo, categoria: c.id, ini: ini, fim: fim, relatorio: c.rel, arrendodar_valor_total: 't' });
        var it = new DOMParser().parseFromString(hh, 'text/html').getElementById('tblMarcaItens');
        if (!it) break;
        var rows = [].slice.call(it.rows, 1).filter(function (r) { return r.cells.length >= 10; });
        rows.forEach(function (r) {
          var cel = [].slice.call(r.cells).map(function (x) { return x.textContent.trim().replace(/\s+/g, ' '); });
          var m = r.innerHTML.match(/MLB-?(\d{6,})/);
          items.push({ cat: c.nome, titulo: cel[1], envio: cel[2], dias: num(cel[3]), vendedor: cel[6].split(' ')[0], cidade: cel[6].split(' ').slice(1).join(' '), marca: cel[7], un: num(cel[8]), fat: num(cel[9]), mlb: m ? 'MLB' + m[1] : '' });
        });
        if (rows.length < 30 || num(rows[rows.length - 1].cells[9].textContent) < 200) break;
        await sleep(300);
      }
      await sleep(300);
    }
    var re = (kw.must || []).map(function (m) { return new RegExp(m); });
    var nao = kw.not ? new RegExp(kw.not) : null;
    var seen = {};
    var L = items.filter(function (i) {
      var key = i.mlb || (i.titulo + '|' + i.vendedor + '|' + i.fat);
      if (seen[key]) return false; seen[key] = 1;
      var t = norm(i.titulo);
      return re.every(function (r) { return r.test(t); }) && !(nao && nao.test(t));
    });
    var total = L.reduce(function (s, i) { return s + i.fat; }, 0), qtd = L.reduce(function (s, i) { return s + i.un; }, 0);
    var agg = function (f) {
      var m = {};
      L.forEach(function (i) { var x = f(i); m[x] = m[x] || { fat: 0, un: 0, n: 0, marcas: {}, cidade: i.cidade }; m[x].fat += i.fat; m[x].un += i.un; m[x].n++; m[x].marcas[i.marca] = 1; });
      return Object.keys(m).map(function (x) { return [x, m[x]]; }).sort(function (a, b) { return b[1].fat - a[1].fat; });
    };
    var vend = agg(function (i) { return i.vendedor; });
    var tit = L.filter(function (i) { return isTit(i.vendedor); });
    var titFat = tit.reduce(function (s, i) { return s + i.fat; }, 0);
    return {
      keyword_id: kw.id, termo: kw.termo, grupo: kw.grupo, ini: ini, fim: fim, coletado_em: new Date().toISOString(), versao: 2,
      total_busca: totalBusca, total: total, qtd: qtd, n_anuncios: L.length, n_vendedores: vend.length, ticket_medio: qtd ? total / qtd : 0,
      titanium: { fat: titFat, un: tit.reduce(function (s, i) { return s + i.un; }, 0), share: total ? titFat / total : 0, anuncios: tit.map(function (i) { return { titulo: i.titulo, envio: i.envio, un: i.un, fat: i.fat, mlb: i.mlb }; }) },
      vendedores: vend.slice(0, 15).map(function (e) { var x = e[1]; return { vendedor: e[0], cidade: x.cidade, fat: x.fat, un: x.un, anuncios: x.n, share: total ? x.fat / total : 0, marcas: Object.keys(x.marcas).slice(0, 3) }; }),
      marcas: agg(function (i) { return brandKey(i.marca); }).slice(0, 10).map(function (e) { return { marca: e[0], fat: e[1].fat, un: e[1].un, share: total ? e[1].fat / total : 0 }; }),
      unifort_terceiros: vend.filter(function (e) { return !isTit(e[0]) && Object.keys(e[1].marcas).some(function (m) { return /unifort/i.test(m); }); }).map(function (e) { return { vendedor: e[0], cidade: e[1].cidade, fat: e[1].fat, un: e[1].un }; }),
      top_anuncios: L.slice().sort(function (a, b) { return b.fat - a.fat; }).slice(0, 12).map(function (i) { return { titulo: i.titulo, vendedor: i.vendedor, cidade: i.cidade, marca: i.marca, envio: i.envio, dias: i.dias, un: i.un, fat: i.fat, mlb: i.mlb }; }),
      produtos: agruparProdutos(L, kw, total),
    };
  }

  /* ── tela flutuante ───────────────────────────────────────── */
  var box = document.createElement('div');
  box.id = 'mic-box';
  box.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:380px;max-height:85vh;overflow:auto;background:#fff;color:#222;border:1px solid #ccc;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:13px/1.45 system-ui,Arial,sans-serif;padding:14px';
  document.body.appendChild(box);
  var fechar = '<span style="float:right;cursor:pointer;color:#888" onclick="document.getElementById(\'mic-box\').style.display=\'none\'">✕</span>';
  var btn = 'padding:6px 12px;border-radius:6px;border:1px solid #2d3277;background:#2d3277;color:#fff;cursor:pointer;font-size:13px';
  var btn2 = 'padding:6px 12px;border-radius:6px;border:1px solid #bbb;background:#fff;color:#222;cursor:pointer;font-size:13px';

  function telaChave(msg) {
    box.innerHTML = fechar + '<b>Inteligência de Mercado</b><p style="margin:8px 0">' + (msg || 'Cole a chave MI_KEY (a mesma do painel). Ela fica salva só neste navegador.') + '</p>' +
      '<input id="mic-k" type="password" placeholder="MI_KEY" style="width:100%;box-sizing:border-box;padding:7px;border:1px solid #bbb;border-radius:6px">' +
      '<div style="margin-top:8px"><button id="mic-ks" style="' + btn + '">Salvar</button></div>';
    document.getElementById('mic-ks').onclick = function () {
      var v = document.getElementById('mic-k').value.trim(); if (v.length < 16) return;
      localStorage.setItem('mi_key', v); inicio();
    };
  }

  async function inicio() {
    if (!localStorage.getItem('mi_key')) return telaChave();
    box.innerHTML = fechar + '<b>Inteligência de Mercado</b><p>Lendo a lista de buscas…</p>';
    var kws, latest;
    try { kws = await mi('/keywords'); latest = await mi('/latest'); }
    catch (e) { return e.message === 'CHAVE_RECUSADA' ? telaChave('Chave recusada pelo Worker. Cole de novo.') : (box.innerHTML = fechar + '<p style="color:#c00">Não consegui falar com o Worker: ' + esc(e.message) + '</p>'); }
    var ult = {}; (latest || []).forEach(function (s) { ult[s.keyword_id] = s; });
    var grupos = {}; kws.forEach(function (kw) { (grupos[kw.grupo || 'Outros'] = grupos[kw.grupo || 'Outros'] || []).push(kw); });
    var lista = Object.keys(grupos).map(function (g) {
      return '<div style="margin-top:8px;font-weight:600;color:#555">' + esc(g) + '</div>' + grupos[g].map(function (kw) {
        var s = ult[kw.id];
        return '<label style="display:flex;gap:6px;align-items:center;margin:2px 0"><input type="checkbox" class="mic-c" value="' + esc(kw.id) + '" checked> ' + esc(kw.termo) +
          ' <span style="color:#888;font-size:11px;margin-left:auto">' + (s ? s.fim.split('-').reverse().slice(0, 2).join('/') : 'nunca') + '</span></label>';
      }).join('');
    }).join('');
    box.innerHTML = fechar + '<b>Inteligência de Mercado — coletar agora</b>' +
      '<p style="margin:6px 0;color:#555">Últimos 90 dias até anteontem. Cerca de 1 minuto por busca; deixe esta aba aberta. Não gasta créditos de IA.</p>' +
      '<div style="display:flex;gap:6px;margin:6px 0"><button id="mic-all" style="' + btn2 + '">Marcar todas</button><button id="mic-none" style="' + btn2 + '">Desmarcar</button></div>' +
      lista + '<div style="margin-top:12px"><button id="mic-go" style="' + btn + '">Coletar selecionadas</button></div>';
    var cks = function () { return [].slice.call(box.querySelectorAll('.mic-c')); };
    document.getElementById('mic-all').onclick = function () { cks().forEach(function (c) { c.checked = true; }); };
    document.getElementById('mic-none').onclick = function () { cks().forEach(function (c) { c.checked = false; }); };
    document.getElementById('mic-go').onclick = function () {
      var ids = cks().filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      if (ids.length) rodar(kws.filter(function (kw) { return ids.indexOf(kw.id) >= 0; }), ult);
    };
  }

  async function rodar(lista, ult) {
    C.rodando = true; C.parar = false;
    var fimD = new Date(Date.now() - 2 * 864e5), iniD = new Date(fimD.getTime() - 89 * 864e5);
    var ini = fmt(iniD), fim = fmt(fimD);
    var feitos = [], erros = [];
    var t0 = Date.now();
    function pinta(atual) {
      var el = (Date.now() - t0) / 1000, rest = feitos.length ? el / feitos.length * (lista.length - feitos.length) : lista.length * 60;
      box.innerHTML = '<b>Coletando ' + (feitos.length + (atual ? 1 : 0)) + ' de ' + lista.length + '</b>' +
        '<div style="height:6px;background:#eee;border-radius:3px;margin:8px 0"><div style="height:6px;border-radius:3px;background:#2d3277;width:' + Math.round(feitos.length / lista.length * 100) + '%"></div></div>' +
        (atual ? '<div>Agora: <b>' + esc(atual) + '</b></div>' : '') + '<div style="color:#888;font-size:12px">faltam ~' + Math.max(1, Math.round(rest / 60)) + ' min · deixe esta aba aberta</div>' +
        '<div style="margin:8px 0;font-size:12px">' + feitos.map(function (f) { return '✓ ' + esc(f.termo) + ' — ' + k(f.total) + ' · Titanium ' + (f.share * 100).toFixed(1) + '%'; }).join('<br>') + '</div>' +
        '<button id="mic-stop" style="' + btn2 + '">Parar</button>';
      document.getElementById('mic-stop').onclick = function () { C.parar = true; this.textContent = 'Parando…'; };
    }
    for (var i = 0; i < lista.length; i++) {
      if (C.parar) break;
      var kw = lista[i]; pinta(kw.termo);
      try {
        var snap = await coletar(kw, ini, fim);
        await mi('/snapshot', 'POST', snap);
        feitos.push({ termo: kw.termo, total: snap.total, share: snap.titanium.share, ant: ult[kw.id] });
      } catch (e) {
        if (e.message === 'PARADO') break;
        if (e.message === 'SESSAO_EXPIRADA') { erros.push('Sessão do Shopping de Preços expirou em "' + kw.termo + '". Entre de novo e rode só as que faltaram.'); break; }
        erros.push(kw.termo + ': ' + e.message);
      }
      await sleep(800);
    }
    C.rodando = false;
    var resumo = feitos.map(function (f) {
      var d = f.ant && f.ant.total ? (f.share - f.ant.titanium.share) * 100 : null;
      return '<tr><td>' + esc(f.termo) + '</td><td style="text-align:right">' + k(f.total) + '</td><td style="text-align:right">' + (f.share * 100).toFixed(1) + '%' +
        (d == null ? '' : ' <span style="color:' + (d >= 0 ? '#080' : '#c00') + '">' + (d >= 0 ? '▲' : '▼') + Math.abs(d).toFixed(1) + '</span>') + '</td></tr>';
    }).join('');
    box.innerHTML = fechar + '<b>Coleta concluída: ' + feitos.length + ' de ' + lista.length + '</b>' +
      (erros.length ? '<div style="color:#c00;margin:6px 0">' + erros.map(esc).join('<br>') + '</div>' : '') +
      '<table style="width:100%;font-size:12px;margin:8px 0;border-collapse:collapse">' + resumo + '</table>' +
      '<a href="' + PAINEL + '" target="_blank" style="' + btn + ';text-decoration:none;display:inline-block">Abrir o painel</a>';
  }

  inicio();
})();
