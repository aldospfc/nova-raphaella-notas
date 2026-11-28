// Testes das regras de ouro do Sistema das Lojas.
// Carregam a página de verdade (fonte/entrada_xml.html) num navegador simulado (jsdom) e conferem as contas
// e o que iria para o Gestão. Rodam sozinhos antes de cada publicação (fonte/scripts/publicar.sh):
// se uma regra quebrar, a versão nova não é publicada.
//
// Rodar à mão:  node fonte/testes/regras.test.js
//
// Regras cobertas:
//  1. Preço só SUGERIDO (markup geral, cinza) nunca vai ao Gestão nem aos caixas; vale o digitado ou o markup do item.
//  2. Meia nota: o valor da nota é dividido pelo % na nota; IPI, ST e DIFAL só sobre a parte faturada; boleto multiplicado.
//  3. DIFAL: fator por origem/CFOP/ST; entra no custo, fica fora do boleto; a parte da Loja 2 no DIFAL entra no que ela paga.
//  4. Rateio dos boletos da Loja 2: proporcional à parte dela na nota; soma das parcelas = total devido.
//  5. Duas notas (uma por loja): cada loja com o seu custo, sem unificar.

const path = require("path");
const fs = require("fs");
const { JSDOM, VirtualConsole } = require(path.join(__dirname, "node_modules", "jsdom"));

const html = fs.readFileSync(path.join(__dirname, "..", "entrada_xml.html"), "utf8");
const vc = new VirtualConsole();
const errosPagina = [];
vc.on("jsdomError", e => errosPagina.push(e.message));
const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://sistema.novaraphaella.com.br/", virtualConsole: vc, pretendToBeVisual: true });
const w = dom.window;
const ev = s => w.eval(s);

// ---------- ajudantes ----------
let ok = 0, falhas = 0, grupo = "";
const secao = t => { grupo = t; console.log("\n" + t); };
function confere(nome, cond, detalhe) {
  if (cond) { ok++; console.log("  ✔ " + nome); }
  else { falhas++; console.log("  ✘ " + nome + (detalhe ? "  →  " + detalhe : "")); }
}
const perto = (a, b, tol = 0.005) => Math.abs(a - b) <= tol;
const igual = (nome, obtido, esperado, tol) => confere(nome, perto(obtido, esperado, tol), `esperado ${esperado}, veio ${obtido}`);

// EAN-13 válido a partir de 12 dígitos
function ean(base12) {
  const d = base12.split("").map(Number);
  const s = d.reduce((a, x, i) => a + x * (i % 2 ? 3 : 1), 0);
  return base12 + ((10 - (s % 10)) % 10);
}
const EAN_A = ean("789100010010"), EAN_B = ean("789100010020"), EAN_C = ean("789100010030");

// item no formato que o parser do XML produz
function item(n, cod, extra) {
  return Object.assign({ n, xprod: "PRODUTO TESTE " + n, desc: "PRODUTO TESTE " + n, ean: cod, eanNota: cod, qtd: 10, div: 1, vun: 10, vprod: 100,
    vdesc: 0, vfrete: 0, voutro: 0, vipi: 0, vst: 0, fd: 1, cfop: "6102", cst: "000", orig: "0", ncm: "48201000", m: false }, extra || {});
}
// prepara a tela: % na nota, markup geral, arredondamento, destino e os itens
function cenario({ pct = 100, mk = 100, arr = "0", dest = "1", lista = [] } = {}) {
  const d = w.document;
  d.getElementById("gPct").value = String(pct);
  d.getElementById("gMk").value = String(mk);
  d.getElementById("gArr").value = arr;
  d.getElementById("gDest").value = dest;
  w.__itens = lista;
  ev(`itens = __itens; cab = { nnf: "123", emit: "FORNECEDOR TESTE", chave: "TESTE" }; cad = null; cadIdx = null; cadAux = null; envioSoChegou = false;`);
  return lista;
}
const sqlPrecos = l => ev(`sqlPrecos(${l})`);
const sqlEntrada = l => ev(`sqlEntrada(${l})`);
const calc = it => w.calc(it);

// ---------- 1. preço sugerido nunca sobe ----------
secao("1. Preço só sugerido nunca vai ao Gestão");
{
  const [a] = cenario({ lista: [item(1, EAN_A)] });
  confere("item sem preço digitado não é 'definido'", ev("precoDefinido")(a) === false);
  confere("envio de preços: nada a enviar", sqlPrecos(1) === null);
  confere("entrada completa: nada a enviar", sqlEntrada(1) === null);
  confere("caixas (POS): nada a enviar", ev("posDoEnvio[1].length") === 0);
}
{
  const [a, b, c] = cenario({ lista: [item(1, EAN_A), item(2, EAN_B, { pv: 25.9 }), item(3, EAN_C, { mk: 50 })] });
  const sp = sqlPrecos(1) || "", se = sqlEntrada(1) || "";
  confere("preço digitado vai (envio de preços)", sp.includes(`'${EAN_B}'`));
  confere("markup do próprio item vai (envio de preços)", sp.includes(`'${EAN_C}'`));
  confere("sugerido fica de fora (envio de preços)", !sp.includes(EAN_A));
  confere("sugerido fica de fora (entrada completa)", se.length > 0 && !se.includes(EAN_A));
  confere("sugerido fica de fora dos caixas", !ev("posDoEnvio[1]").some(o => o.e === EAN_A));
  confere("preço digitado vai com o valor exato", sp.includes("PRECO_VENDA1 = 25.90"), sp.slice(0, 200));
  igual("markup do item: custo 10 + 50% = 15,00", calc(c).venda, 15);
}
{
  cenario({ dest: "ambas", lista: [item(1, EAN_A), item(2, EAN_B, { pv: 12, pv2: 13 })] });
  const s2 = sqlPrecos(2) || "";
  confere("Loja 2: sugerido também fica de fora", !s2.includes(EAN_A));
  confere("Loja 2: vai com o preço dela (13,00)", s2.includes("PRECO_VENDA1 = 13.00"), s2.slice(0, 200));
}

// ---------- 2. meia nota ----------
secao("2. Meia nota");
{
  const [a] = cenario({ pct: 50, lista: [item(1, EAN_A, { vprod: 100, vipi: 10, pv: 50 })] });
  const k = calc(a);
  igual("valor cheio = nota ÷ 50% e IPI não dobra (100/0,5 + 10 = 210)", k.custoItem, 210);
  igual("custo unitário = 210 ÷ 10 = 21,00", k.custoUn, 21);
}
{
  const [a] = cenario({ pct: 50, lista: [item(1, EAN_A, { vprod: 100, fd: 0.94, pv: 50 })] });
  const k = calc(a), difal = 100 / 0.94 - 100;
  igual("DIFAL só sobre a parte faturada (100/0,94 − 100 = 6,38)", k.difal, 6.38);
  igual("custo = 200 + 6,38", k.custoItem, 206.38);
}
{
  const [a] = cenario({ pct: 100, lista: [item(1, EAN_A, { vprod: 100, pct: 50, pv: 50 })] });
  igual("% na nota do próprio item vale mais que o geral", calc(a).custoItem, 200);
}
{
  const nota = { cfg: { fb: 2 } };
  igual("boleto da nota é multiplicado (500 × 2 = 1000)", ev("aPagar")(nota, { valor: 500, nf: true }), 1000);
  igual("boleto avulso (fora da nota) não multiplica", ev("aPagar")(nota, { valor: 500, nf: false }), 500);
  igual("nota inteira: boleto como veio", ev("aPagar")({ cfg: {} }, { valor: 500, nf: true }), 500);
}

// ---------- 3. DIFAL ----------
secao("3. DIFAL");
{
  const f = ev("fatorDifal");
  const base = { cfop: "6102", cst: "000", orig: "0", vst: 0 };
  igual("fornecedor de SP: sem DIFAL", f(base, "SP"), 1);
  igual("CFOP 5xxx: sem DIFAL", f({ ...base, cfop: "5102" }, "MG"), 1);
  igual("com ST: sem DIFAL", f({ ...base, vst: 3 }, "MG"), 1);
  igual("CST de ST (…60): sem DIFAL", f({ ...base, cst: "060" }, "MG"), 1);
  igual("nacional de fora de SP: fator 0,94", f(base, "MG"), 0.94);
  igual("importado (origem 1): fator 0,86", f({ ...base, orig: "1" }, "MG"), 0.86);
}
{
  const [a] = cenario({ lista: [item(1, EAN_A, { vprod: 1000, fd: 0.94, pv: 200 })] });
  const k = calc(a);
  igual("DIFAL entra no custo do item", k.custoItem, 1063.83);
  igual("DIFAL do item = 63,83", k.difal, 63.83);
}

// ---------- 4. rateio dos boletos da Loja 2 ----------
secao("4. Rateio dos boletos com a Loja 2");
{
  // nota de 1000 + DIFAL 63,83; 4 de 10 unidades vão para a Loja 2; dois boletos de 500
  cenario({ dest: "div", lista: [item(1, EAN_A, { vprod: 1000, qtd: 10, vun: 100, fd: 0.94, l2u: 4, pv: 200 })] });
  const r = ev("rateioLoja2")({ cfg: {} }, [{ n: "1/2", valor: 500, nf: true }, { n: "2/2", valor: 500, nf: true }]);
  const difal2 = (1000 / 0.94 - 1000) * 0.4;
  igual("parte da Loja 2 nos boletos = 40% de 1000", r.bol, 400);
  igual("parte da Loja 2 no DIFAL = 40% de 63,83", r.difal2, Math.round(difal2 * 100) / 100);
  igual("total da Loja 2 = boletos + DIFAL", r.total2, 400 + Math.round(difal2 * 100) / 100);
  igual("soma das parcelas = total da Loja 2", r.partes.reduce((s, x) => s + x, 0), r.total2, 0.011);
  confere("cada parcela tem a parte do DIFAL (DIFAL pago pela Loja 1 entra no que a Loja 2 paga)", r.partes.every(p => p > 200), JSON.stringify(r.partes));
}
{
  // meia nota: boletos do XML são a metade; a Loja 2 paga sobre o valor multiplicado
  cenario({ pct: 50, dest: "div", lista: [item(1, EAN_A, { vprod: 500, qtd: 10, vun: 50, l2u: 5, pv: 200 })] });
  const r = ev("rateioLoja2")({ cfg: { fb: 2 } }, [{ n: "1/1", valor: 500, nf: true }]);
  igual("meia nota: Loja 2 paga metade do valor multiplicado (50% de 1000)", r.bol, 500);
  igual("meia nota: parcela da Loja 2 = 500", r.partes[0], 500);
}
{
  const [a] = cenario({ dest: "div", lista: [item(1, EAN_A, { qtd: 10, l2u: 3, pv: 20 })] });
  const [q1, q2] = ev("qLojas")(a, calc(a));
  confere("divisão: 7 unidades na Loja 1 e 3 na Loja 2", q1 === 7 && q2 === 3, `${q1} / ${q2}`);
  const e2 = sqlEntrada(2) || "";
  confere("entrada na Loja 2 leva só as 3 unidades dela", /ATUALIZAR_ESTOQUE \(1, 1, 1, '\d+', 'S', 3,/.test(e2), e2.slice(-300));
}

// ---------- 5. duas notas ----------
secao("5. Duas notas: cada loja com o seu custo");
{
  const a = item(1, EAN_A, { qtd: 10, vun: 10, vprod: 100, pv: 30, pv2: 31, b: { n: 1, qtd: 5, vun: 12, vprod: 60, vdesc: 0, vfrete: 0, voutro: 0, vipi: 0, vst: 0, fd: 1 } });
  cenario({ dest: "duas", lista: [a] });
  igual("Loja 1: custo unitário da nota dela (10,00)", ev("calcL")(a, 1).custoUn, 10);
  igual("Loja 2: custo unitário da nota dela (12,00)", ev("calcL")(a, 2).custoUn, 12);
  const e1 = sqlEntrada(1) || "", e2 = sqlEntrada(2) || "";
  confere("entrada Loja 1 com custo 10,000", e1.includes("10.000"), e1.slice(0, 300));
  confere("entrada Loja 2 com custo 12,000 (sem unificar)", e2.includes("12.000") && !e2.includes(" 11.333"), e2.slice(0, 300));
}

// ---------- 6. orçamento para o caixa ----------
secao("6. Orçamento para o caixa (arquivo do POS)");
{
  // linhas reais geradas pelo Gestão (orçamento 28 e orçamentos antigos) — o sistema tem que gerar idêntico
  const fis = ev("orFiscalDoGestao")(["CODIGO_BARRAS                   7908077451455", "ALIQUOTA                        3", "UNIDADE                         Un", "CUSTO_MEDIO                     14.89",
    "S_NCM                           48202000", "F_ALIQNAC                       13.45", "F_ALIQNAC_EST                   18.00", "ICMS                            18.00", "S_CEST                          1902100", "",
    "CODIGO_BARRAS                   0000000001267", "ALIQUOTA                        3", "UNIDADE                         Un", "CUSTO_MEDIO                     2.0000000", "S_NCM                           <null>", "ICMS                            0.00"].join("\r\n"));
  const linha = ev("orLinhaCaixa");
  const l1 = linha("7908077451455", "Caderno 1 Mat Back to Black", 1, 27, fis.get("7908077451455"));
  confere("item com dados fiscais sai igual ao do Gestão", l1 === "17908077451455CADERNO 1 MAT BACK TO BLACK   0000010000027.0003UnC0000014.89T013.45N48202000S018.00102O018.0019021000000000.00", l1);
  const l2 = linha("0000000001267", "PAPEL CARTAO", 4, 2, fis.get("0000000001267"));
  confere("item sem NCM sai na forma curta, igual ao do Gestão", l2 === "10000000001267PAPEL CARTAO                  0000040000002.0003UnC0000002.000000000.00", l2);
  const o = { num: 12, descPct: 10, itens: [{ ean: "7908077451455", qtd: 2, pv: 27 }] };
  confere("número no caixa = 9 + nº do orçamento (8 dígitos)", ev("orNumCaixa")(o) === "90000012");
  igual("desconto geral do orçamento vai embutido no preço do item (27 − 10% = 24,30)", ev("orPrecoCaixa")(o, o.itens[0]), 24.3);
  igual("total do caixa = 2 × 24,30", ev("orTotalCaixa")(o), 48.6);
  const oc = { num: 12, loja: 1, descPct: 0, itens: [{ ean: "7908077451455", desc: "CADERNO", qtd: 1, pv: 27 }], caixaNum: "90000012", caixaTot: 27 };
  confere("PDF do orçamento enviado ao caixa leva o código de barras do número", /class="cx"[\s\S]*class="bar"[\s\S]*90000012/.test(ev("orHtmlDoc")(oc, "pdf")));
  oc.itens[0].pv = 30;
  confere("orçamento alterado depois do envio não leva código de barras (evita bipar valor antigo)", !/class="cx"/.test(ev("orHtmlDoc")(oc, "pdf")));
  confere("descrição longa é cortada em 29 letras e sem acento", linha("7908077451455", "Etiqueta c/100 Estrela de Daví dourada", 1, 2.5, fis.get("7908077451455")).slice(14, 44) === "ETIQUETA C/100 ESTRELA DE DAV ");
}

// ---------- 7. cliente do orçamento ----------
secao("7. Cliente do orçamento");
{
  const v = ev("cpfValido");
  confere("CPF válido é aceito", v("529.982.247-25") === true);
  confere("CPF com dígito errado é apontado", v("529.982.247-26") === false);
  confere("CPF com todos os dígitos iguais é apontado", v("111.111.111-11") === false);
}

// ---------- 8. prazo e adiamento dos boletos ----------
secao("8. Boletos: prazo (30/60/90) e adiar");
{
  const pd = ev("prazoDias"), bp = ev("boletosPorPrazo"), ad = ev("adiarBoletos"), md = ev("dataMaisDias");
  confere("prazo 30/60/90 é entendido", JSON.stringify(pd("30/60/90")) === "[30,60,90]");
  confere("prazo com espaço ou vírgula também (7 14, 21)", JSON.stringify(pd("7 14, 21")) === "[7,14,21]");
  confere("prazo vazio ou absurdo é recusado", pd("") === null && pd("abc") === null && pd("30/9999") === null);
  confere("soma de dias vira o mês e o ano certo", md("2026-12-15", 30) === "2027-01-14" && md("2027-01-31", 28) === "2027-02-28");
  // nota sem boletos: cria as parcelas dividindo o valor, centavos na última
  let r = bp([], [30, 60, 90], "2026-11-27", 1000, false);
  confere("sem boletos: cria 3 parcelas com os vencimentos certos", r.boletos.length === 3 && r.boletos.map(b => b.venc).join() === "2026-12-27,2027-01-26,2027-02-25", JSON.stringify(r.boletos));
  igual("soma das parcelas = valor da nota (1000)", r.boletos.reduce((a, b) => a + b.valor, 0), 1000, 0.001);
  confere("centavos de diferença ficam na última parcela (333,33 / 333,33 / 333,34)", r.boletos.map(b => b.valor).join() === "333.33,333.33,333.34");
  confere("parcelas criadas contam como boleto da nota (meia nota multiplica)", r.boletos.every(b => b.nf === 1));
  // mesmo número de boletos em aberto: só troca os vencimentos; pago e à vista não mudam
  const bs = [{ n: "001", venc: "2026-12-01", valor: 500, nf: 1, pago: "2026-12-01T10:00:00Z" }, { n: "002", venc: "2026-12-31", valor: 300, nf: 1, pago: null }, { n: "003", venc: "2027-01-30", valor: 200, nf: 1, pago: null }, { n: "À vista entrega", fp: "ent", venc: "2026-11-27", valor: 50, pago: null }];
  r = bp(bs, [45, 75], "2026-11-27", 1000, false);
  confere("2 em aberto + prazo de 2: só os vencimentos mudam", r.boletos[1].venc === "2027-01-11" && r.boletos[2].venc === "2027-02-10" && r.boletos[1].valor === 300 && r.boletos[2].valor === 200, JSON.stringify(r.boletos));
  confere("boleto pago e pagamento na entrega não são tocados", r.boletos[0].venc === "2026-12-01" && r.boletos[3].venc === "2026-11-27");
  // número diferente: pergunta antes; confirmando, troca os em aberto dividindo o mesmo valor
  r = bp(bs, [30, 60, 90], "2026-11-27", 1000, false);
  confere("parcelas em número diferente: pergunta antes de trocar", !!r.pergunta && !r.boletos);
  r = bp(bs, [30, 60, 90], "2026-11-27", 1000, true);
  const novos = r.boletos.filter(b => !b.pago && !b.fp);
  confere("confirmando: 3 parcelas novas no lugar das 2 em aberto", novos.length === 3 && r.boletos.length === 5, JSON.stringify(r.boletos));
  igual("as parcelas novas somam o mesmo valor que estava em aberto (500)", novos.reduce((a, b) => a + b.valor, 0), 500, 0.001);
  // jogo da Loja 2 é tratado separado
  const dois = [{ n: "001", venc: "2026-12-01", valor: 100, nf: 1, pago: null }, { n: "001 L2", venc: "2026-12-01", valor: 100, nf: 1, pago: null, l2: 1 }];
  r = bp(dois, [30], "2026-11-27", 100, false);
  confere("as duas lojas: cada jogo de boletos recebe o prazo", r.boletos.every(b => b.venc === "2026-12-27") && r.boletos[1].l2 === 1);
  // adiar
  const a1 = ad(bs, 10);
  confere("adiar 10 dias: só os 2 em aberto com vencimento mudam", a1.n === 2 && a1.boletos[1].venc === "2027-01-10" && a1.boletos[2].venc === "2027-02-09" && a1.boletos[0].venc === "2026-12-01" && a1.boletos[3].venc === "2026-11-27", JSON.stringify(a1.boletos));
  confere("adiar não altera os boletos originais antes de confirmar", bs[1].venc === "2026-12-31");
  confere("número negativo antecipa", ad(bs, -5).boletos[1].venc === "2026-12-26");
}

// ---------- 9. clientes ----------
secao("9. Clientes (juntados a partir dos orçamentos)");
{
  const orcs = [
    { id: "a", num: 1, cliente: "Maria Silva", tel: "(11) 99935-7023", status: "venda", criado: "2026-11-01T10:00:00Z", loja: 1, itens: [{ qtd: 2, pv: 10 }], descPct: 0 },
    { id: "b", num: 2, cliente: "maria silva", tel: "11999357023", cpf: "529.982.247-25", status: "aberto", validade: "2099-01-01", criado: "2026-11-20T10:00:00Z", loja: 1, itens: [{ qtd: 1, pv: 5 }], descPct: 0 },
    { id: "c", num: 3, cliente: "Maria S.", cpf: "52998224725", status: "perdido", criado: "2026-11-25T10:00:00Z", loja: 2, itens: [], descPct: 0 },
    { id: "d", num: 4, cliente: "João", status: "aberto", criado: "2026-11-26T10:00:00Z", loja: 1, itens: [], descPct: 0 },
    { id: "e", num: 5, cliente: "", status: "aberto", criado: "2026-11-27T10:00:00Z", loja: 1, itens: [], descPct: 0 },
  ];
  const cl = ev("clMontar")(orcs, [{ id: "x", nome: "Maria da Silva", tel: "11 99935-7023", promo: true, obs: "escola A" }]);
  const maria = cl.find(c => c.orcs.length === 3);
  confere("mesmo WhatsApp ou mesmo CPF = mesma pessoa (3 orçamentos juntos)", !!maria && cl.length === 2, cl.map(c => c.nome + ":" + c.orcs.length).join(" | "));
  confere("o cadastro feito à mão vale para o nome e guarda o aceite de promoções", maria && maria.nome === "Maria da Silva" && maria.cad.promo === true);
  igual("total de vendas do cliente (2 × 10)", maria ? maria.totalVendas : -1, 20);
  confere("orçamento em aberto e dentro da validade aparece como em aberto", maria && maria.abertos.length === 1 && maria.abertos[0].num === 2);
  confere("orçamento sem nome, CPF nem WhatsApp não vira cliente", !cl.some(c => c.orcs.some(o => o.num === 5)));
  const t = ev("clTexto")("Olá, {nome}! Orçamento nº {numero} vale até {validade}, total {total}, Loja {loja}.", { nome: "Maria da Silva" }, orcs[1]);
  confere("mensagem troca nome, número, validade, total e loja", t === "Olá, Maria! Orçamento nº 2 vale até 01/01/2099, total R$ 5,00, Loja 1.", t);
  // a tela desenha sem erro
  w.Element.prototype.scrollIntoView = function () {}; // o navegador simulado não tem rolagem
  w.OR_teste = orcs; ev("OR.docs = new Map(OR_teste.map(o => [o.id, o])); clDesenharLista(); clAbrir(clTodos().find(c => c.orcs.length === 3).chave)");
  confere("tela de Clientes desenha a lista (2 clientes)", w.document.querySelectorAll("#clLista .bcard").length === 2);
  confere("ficha do cliente mostra os 3 orçamentos e o botão de lembrar a validade", w.document.querySelectorAll("#clEd [data-orc]").length === 3 && w.document.querySelectorAll("#clEd [data-val]").length === 1);
}

// ---------- 10. nota de devolução de compra ----------
secao("10. Nota de devolução de compra (rascunho no Bling)");
{
  // recorte de uma NF-e real de compra (fornecedor de SP, regime normal, ICMS 18%, um item com IPI)
  const det = (n, ean, desc, ncm, q, vun, vprod, vicms, ipi) => `<det nItem="${n}"><prod><cProd>PR ${n}</cProd><cEAN>${ean}</cEAN><xProd>${desc}</xProd><NCM>${ncm}</NCM><CFOP>5101</CFOP><uCom>PC</uCom><qCom>${q}.0000</qCom><vUnCom>${vun}</vUnCom><vProd>${vprod}</vProd></prod><imposto><ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${vprod}</vBC><pICMS>18.0000</pICMS><vICMS>${vicms}</vICMS></ICMS00></ICMS><IPI>${ipi ? `<IPITrib><CST>50</CST><vBC>${vprod}</vBC><pIPI>6.5000</pIPI><vIPI>${ipi}</vIPI></IPITrib>` : `<IPINT><CST>51</CST></IPINT>`}</IPI></imposto></det>`;
  const xml = `<?xml version="1.0"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe35261147741285000185550010000309081517341830"><ide><serie>1</serie><nNF>30908</nNF><dhEmi>2026-11-25T11:20:37-03:00</dhEmi></ide><emit><CNPJ>47741285000185</CNPJ><xNome>FORNECEDOR TESTE LTDA</xNome><enderEmit><xLgr>AV TESTE</xLgr><nro>25</nro><xBairro>CENTRO</xBairro><xMun>SAO PAULO</xMun><UF>SP</UF><CEP>08490490</CEP><fone>1125597070</fone></enderEmit><IE>109634360110</IE><CRT>3</CRT></emit><dest><CNPJ>26834196000103</CNPJ></dest>${det(1, "7897216950310", "PRANCHETA EUCATEX", "44219900", 48, "2.7500000000", "132.00", "23.76", "")}${det(2, "7897216901930", "ESPETO P/PAPEL", "83059000", 10, "6.9500000000", "69.50", "12.51", "4.52")}</infNFe></NFe></nfeProc>`;
  const nota = ev("dvLerXml")(xml), montar = ev("dvMontar");
  confere("lê a nota de origem (número, série, emissão, chave, 2 itens)", nota.nnf === "30908" && nota.serie === "1" && nota.emissao === "2026-11-25" && nota.chave.length === 44 && nota.itens.length === 2);
  const m = montar(nota, { 1: 12, 2: 10 }, "mercadoria com defeito", { email: "nf@fornecedor.com" }, {});
  confere("CFOP espelho: compra 5.101 sem ST → devolução 5.202", m.cfops.join() === "5202");
  igual("unitário é o da nota de origem (2,75)", m.itens[0].vun, 2.75);
  igual("total do item = quantidade × unitário da origem (12 × 2,75)", m.itens[0].total, 33);
  igual("ICMS proporcional à quantidade devolvida (12 de 48 → 23,76 ÷ 4)", m.itens[0].vicms, 5.94);
  igual("IPI da origem devolvido inteiro quando devolve tudo do item", m.itens[1].vipi, 4.52);
  igual("total da nota = produtos + IPI devolvido (33 + 69,50 + 4,52)", m.t.vnf, 107.02);
  confere("devolução de parte de um item é PARCIAL", m.total === false && m.obs.startsWith("DEVOLUCAO PARCIAL REFERENTE A NF-E N. 30908, SERIE 1, EMITIDA EM 25/11/2026, CHAVE 35261147741285000185550010000309081517341830."));
  confere("informações complementares levam base e valor do ICMS, IPI e a frase do Simples", m.obs.includes("BASE DE CALCULO ICMS R$ 102,50 - ICMS R$ 18,45 - IPI R$ 4,52") && m.obs.includes("NAO GERA DIREITO A CREDITO FISCAL DE IPI") && m.obs.includes("MOTIVO: MERCADORIA COM DEFEITO"), m.obs);
  confere("nota para o Bling: saída, finalidade devolução, origem referenciada pela chave", m.nfe.tipo === 1 && m.nfe.finalidade === 4 && m.nfe.documentoReferenciado.chaveAcesso === nota.chave && m.nfe.documentoReferenciado.numero === "30908");
  confere("fornecedor vai com CNPJ, IE e endereço do XML", m.nfe.contato.numeroDocumento === "47741285000185" && m.nfe.contato.ie === "109634360110" && m.nfe.contato.endereco.uf === "SP" && m.nfe.contato.email === "nf@fornecedor.com");
  confere("item vai com código de barras, NCM formatado e unitário da origem", m.nfe.itens[0].codigo === "7897216950310" && m.nfe.itens[0].classificacaoFiscal === "4421.99.00" && m.nfe.itens[0].valor === 2.75 && m.nfe.itens[0].quantidade === 12);
  const tudo = montar(nota, { 1: 48, 2: 10 }, "x", null, {});
  confere("devolver todos os itens inteiros é devolução TOTAL", tudo.total === true && tudo.obs.startsWith("DEVOLUCAO TOTAL"));
  igual("devolução total fecha com a nota de origem (132 + 69,50 + 4,52)", tudo.t.vnf, 206.02);
  const demais = montar(nota, { 1: 40 }, "x", null, { 1: 12 });
  confere("não deixa devolver mais do que o saldo (já devolveu 12 de 48, pede 40)", demais.erros.length === 1 && demais.itens.length === 0, JSON.stringify(demais.erros));
  confere("fornecedor de SP com ICMS 18% em todos os itens: usa a natureza que calcula o ICMS sozinha", m.nat.icms === "auto" && m.nat.aliq === 18 && m.nfe.naturezaOperacao.id === 15112032159);
  const xmlSimples = xml.replace(/<ICMS00>.*?<\/ICMS00>/g, "<ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102>");
  const ms = montar(ev("dvLerXml")(xmlSimples), { 1: 2 }, "x", null, {});
  confere("fornecedor do Simples (sem ICMS destacado): natureza base e nenhum ICMS a informar", ms.nat.icms === "nenhum" && ms.nfe.naturezaOperacao.id === 14220696243);
  const xmlMisto = xml.replace("<pICMS>18.0000</pICMS><vICMS>12.51</vICMS>", "<pICMS>12.0000</pICMS><vICMS>8.34</vICMS>");
  const mm = montar(ev("dvLerXml")(xmlMisto), { 1: 2, 2: 1 }, "x", null, {});
  confere("alíquotas diferentes na mesma devolução: natureza base e ICMS digitado no Bling", mm.nat.icms === "manual" && mm.nfe.naturezaOperacao.id === 14220696243);
  const st = ev("dvCfop");
  confere("compra com ST vira x.411; de fora do estado vira 6.xxx", st({ cfop: "5403", cst: "10", vicmsst: 3 }) === "5411" && st({ cfop: "6102", cst: "00", vicmsst: 0 }) === "6202" && st({ cfop: "6403", cst: "10", vicmsst: 1 }) === "6411");
}

// ---------- 11. e-commerce sem clique ----------
secao("11. E-commerce sem clique (conferiu bipando → despachado)");
{
  const sai = ev("ckSaiSozinho");
  confere("Shopee conferido inteiro sai como despachado sozinho", sai({ canal: "Shopee", situacao_id: 6 }, "") === true);
  confere("Mercado Livre NÃO sai sozinho (quem avisa a saída é o ML)", sai({ canal: "Mercado Livre", situacao_id: 6 }, "") === false);
  confere("conferência fechada COM FALTA não despacha", sai({ canal: "Shopee", situacao_id: 6 }, "faltou 1 caneta") === false);
  confere("pedido cancelado não despacha", sai({ canal: "Shopee", situacao_id: 12 }, "") === false && sai({ canal: "Shopee", situacao_id: 6, ignorado_em: "2026-11-28" }, "") === false);
  confere("pedido já despachado não é marcado de novo", sai({ canal: "Shopee", situacao_id: 6, despachado_em: "2026-11-28" }, "") === false);
}

// ---------- resultado ----------
if (errosPagina.length) { falhas++; console.log("\n✘ a página teve erro ao carregar: " + errosPagina.slice(0, 3).join(" | ")); }
console.log(`\n${ok} regras ok, ${falhas} com problema.`);
process.exit(falhas ? 1 : 0);
