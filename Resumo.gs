/**
 * Resumo.gs — aba "Resumo": visão enxuta dos envios dos últimos 14 dias úteis.
 * É reescrita a cada atualização de rastreio (de hora em hora) e pelo menu 📦 Rastreio.
 *
 * "Dias em trânsito (úteis)" conta só dias úteis (seg–sex), para dar para comparar
 * direto com o "Prazo LI", que também é em dias úteis. Feriados não são descontados.
 * Linha em vermelho = passou do prazo LI (entregue com atraso ou ainda atrasado).
 */
const RESUMO_DIAS_UTEIS = 14;
const COLUNAS_RESUMO = ['Pedido LI', 'Forma de envio', 'Código rastreio', 'Data vínculo',
                        'Dias em trânsito (úteis)', 'Prazo LI (dias úteis)'];

/** Conta dias úteis (seg–sex) entre duas datas: não conta o dia inicial, conta o final. */
function diasUteisEntre_(inicio, fim) {
  const a = new Date(inicio); a.setHours(0, 0, 0, 0);
  const b = new Date(fim); b.setHours(0, 0, 0, 0);
  let dias = 0;
  while (a < b) {
    a.setDate(a.getDate() + 1);
    const dia = a.getDay();
    if (dia !== 0 && dia !== 6) dias++;
  }
  return dias;
}

/** Data de N dias úteis atrás (00:00). */
function voltarDiasUteis_(agora, n) {
  const d = new Date(agora); d.setHours(0, 0, 0, 0);
  let contados = 0;
  while (contados < n) {
    d.setDate(d.getDate() - 1);
    const dia = d.getDay();
    if (dia !== 0 && dia !== 6) contados++;
  }
  return d;
}

/** Monta as linhas do resumo a partir das linhas da aba Envios (função pura, testável). */
function montarResumo_(linhas, agora) {
  const corte = voltarDiasUteis_(agora, RESUMO_DIAS_UTEIS).getTime();
  return linhas
    .filter(function (o) { return o['Data vínculo'] && new Date(o['Data vínculo']).getTime() >= corte; })
    .sort(function (a, b) { return new Date(b['Data vínculo']) - new Date(a['Data vínculo']); })
    .map(function (o) {
      let dias = '';
      if (o['Data postagem']) {
        const fim = (o['Status código'] === 'ENTREGUE' && o['Data último evento']) ? o['Data último evento'] : agora;
        dias = diasUteisEntre_(o['Data postagem'], fim);
      }
      const prazo = Number(o['Prazo LI (dias úteis)']) || '';
      return {
        valores: [o['Pedido LI'],
          (o['Enviado por'] && nomeComparavel_(o['Enviado por']).indexOf(nomeComparavel_(o['Forma de envio'])) < 0)
            ? o['Forma de envio'] + ' → ' + o['Enviado por'] : o['Forma de envio'],
          o['Código rastreio'], new Date(o['Data vínculo']), dias, prazo],
        atrasado: dias !== '' && prazo !== '' && dias > prazo
      };
    });
}

function atualizarResumo() {
  const ss = planilha_();
  let aba = ss.getSheetByName('Resumo');
  if (!aba) {
    aba = ss.insertSheet('Resumo', 0);  // primeira aba da planilha
    aba.setFrozenRows(1);
  }
  const linhas = montarResumo_(lerEnvios_().linhas, new Date());

  aba.clear();
  aba.getRange(1, 1, 1, COLUNAS_RESUMO.length).setValues([COLUNAS_RESUMO])
    .setFontWeight('bold').setBackground('#1f3b5c').setFontColor('#ffffff');
  if (linhas.length) {
    const range = aba.getRange(2, 1, linhas.length, COLUNAS_RESUMO.length);
    aba.getRange(2, 3, linhas.length, 1).setNumberFormat('@');  // código como texto
    range.setValues(linhas.map(function (l) { return l.valores; }));
    aba.getRange(2, 4, linhas.length, 1).setNumberFormat('dd/MM/yyyy');
    range.setBackgrounds(linhas.map(function (l) {
      const cor = l.atrasado ? '#f4c7c3' : null;
      return COLUNAS_RESUMO.map(function () { return cor; });
    }));
  }
  aba.getRange(linhas.length + 3, 1).setValue('Últimos ' + RESUMO_DIAS_UTEIS + ' dias úteis · atualizado em ' +
    agoraStr_('dd/MM/yyyy HH:mm') + ' · vermelho = passou do prazo LI').setFontColor('#666666').setFontStyle('italic');
  aba.autoResizeColumns(1, COLUNAS_RESUMO.length);
}
