/**
 * Diagnostico.gs — testes para rodar ANTES de ligar o sistema.
 * Cada diagnóstico escreve o resultado na aba "Diagnóstico" (e no log de execução).
 * Use para confirmar credenciais e o nome real dos campos de cada API.
 */

function saidaDiag_(titulo, conteudo) {
  const ss = planilha_();
  let aba = ss.getSheetByName('Diagnóstico');
  if (!aba) aba = ss.insertSheet('Diagnóstico');
  const texto = typeof conteudo === 'string' ? conteudo : JSON.stringify(conteudo, null, 2);
  aba.insertRowBefore(1);
  aba.getRange(1, 1, 1, 3).setValues([[agoraStr_(), titulo, texto.substring(0, 49000)]]);
  aba.getRange(1, 3).setWrap(true);
  aba.setColumnWidth(3, 900);
  console.log(titulo + '\n' + texto);
}

function perguntar_(msg) {
  try {
    const ui = SpreadsheetApp.getUi();
    const r = ui.prompt(msg);
    return r.getSelectedButton() === ui.Button.OK ? r.getResponseText().trim() : '';
  } catch (e) {
    return ''; // rodando pelo editor: sem janela
  }
}

/** 1) Loja Integrada: credenciais, situações e um pedido "Enviado" de exemplo. */
function diagnosticoLojaIntegrada() {
  try {
    const sit = liGet_('/situacao/', { limit: 100 });
    const lista = ((sit && (sit.objects || sit)) || []).map(function (s) { return s.id + ' = ' + s.codigo + ' (' + s.nome + ')'; });
    saidaDiag_('LI — situações disponíveis', lista.join('\n'));

    const desde = prop_('DATA_INICIO') ||
      Utilities.formatDate(new Date(Date.now() - 7 * 86400000), CONFIG.FUSO, 'yyyy-MM-dd HH:mm:ss');
    const numeros = liListarEnviadosDesde_(desde);
    saidaDiag_('LI — pedidos "Enviado" atualizados desde ' + desde, numeros.length + ' pedidos: ' + numeros.slice(0, 50).join(', '));

    const numero = perguntar_('Número de um pedido ENVIADO para inspecionar (vazio = o primeiro da lista):') || numeros[0];
    if (!numero) return;
    const p = liDetalhePedido_(numero);
    saidaDiag_('LI — pedido ' + numero + ' (campos de envio brutos)', { situacao: p && p.situacao, envios: p && p.envios });
    saidaDiag_('LI — pedido ' + numero + ' (como o sistema entende)', {
      resumo: liResumoPedido_(p),
      envios: liExtrairEnvios_(p).map(function (e) {
        return Object.assign(e, {
          monitorado: formaMonitorada_(e.formaNome, e.formaCodigo, e.codigo),
          rota: decidirRota_(e.codigo, e.formaNome, e.formaCodigo, correiosDisponivel_())
        });
      })
    });
  } catch (e) {
    saidaDiag_('LI — ERRO', e.message);
  }
}

/** 2) Melhor Envio: token, uma etiqueta postada de exemplo e busca por código. */
function diagnosticoMelhorEnvio() {
  try {
    const lista = meGet_('/orders', { status: 'posted', page: 1 });
    const itens = (lista && lista.data) || [];
    saidaDiag_('ME — etiquetas postadas (amostra)', itens.slice(0, 3).map(function (it) {
      return { id: it.id, protocol: it.protocol, status: it.status, tracking: it.tracking,
               self_tracking: it.self_tracking, criada: it.created_at, servico: it.service && it.service.name,
               transportadora: it.service && it.service.company && it.service.company.name };
    }));
    const codigo = perguntar_('Código de rastreio de um pedido Jadlog (como está na LI):');
    if (!codigo) return;
    const info = {};
    const achados = meIndexarEtiquetas_([codigo.toUpperCase()], new Date(Date.now() - CONFIG.JANELA_MAX_DIAS * 86400000), null, info);
    const id = achados[codigo.toUpperCase()] || null;
    const varredura = info.etiquetas + ' etiquetas em ' + info.paginas + ' páginas, a mais antiga criada em ' +
      (info.maisAntiga ? fmtData_(new Date(info.maisAntiga)) : '?');
    saidaDiag_('ME — busca "' + codigo + '"', id
      ? 'Encontrado: etiqueta ' + id + ' (campo: ' + info.campos[codigo.toUpperCase()] + ')\nVarridas ' + varredura
      : 'NÃO encontrado em nenhum campo das etiquetas do Melhor Envio.\nVarridas ' + varredura +
        '.\nSe a data da etiqueta é anterior a essa, aumente ME_MAX_PAGINAS_BUSCA; se não, essa etiqueta provavelmente não foi gerada nesta conta do Melhor Envio.');
    if (id) {
      const st = meStatusLote_([id]);
      const norm = meNormalizar_(st[id]);
      saidaDiag_('ME — status da etiqueta ' + id, { bruto: st[id], statusInterno: statusPorMelhorEnvio_(norm.statusMe, norm.eventos) });
      const det = meDetalhe_(id) || {};
      // só campos de rastreio — o detalhe completo traz dados pessoais (CPF, telefone, e-mail)
      saidaDiag_('ME — detalhe da etiqueta ' + id, {
        motivoEncontrado: motivoNoDetalhe_(det), status: det.status, pedidoLI: pedidoDaEtiqueta_(det),
        authorization_code: det.authorization_code, tracking: det.tracking, self_tracking: det.self_tracking,
        servico: det.service && ((det.service.company && det.service.company.name) + ' ' + det.service.name),
        posted_at: det.posted_at, delivered_at: det.delivered_at, suspended_at: det.suspended_at,
        chamados: (det.tickets || []).length, pode_abrir_chamado: det.can_open_ticket
      });
    }
  } catch (e) {
    saidaDiag_('ME — ERRO', e.message);
  }
}

/** 3) Correios: token e rastreio de um código. */
function diagnosticoCorreios() {
  try {
    const chave = prop_('CORREIOS_CODIGO_ACESSO');
    if (!correiosDisponivel_()) {
      saidaDiag_('Correios', 'CORREIOS_CODIGO_ACESSO não preenchida (ou, no modelo antigo, faltam CORREIOS_USUARIO / CORREIOS_CARTAO_POSTAGEM).');
      return;
    }
    if (correiosUsaChaveDireta_()) {
      saidaDiag_('Correios — autenticação', 'Chave de acesso direta ("' + chave.substring(0, 4) + '...", ' + chave.length +
        ' caracteres). Usada como Bearer, sem usuário/cartão.');
    } else {
      // Modelo antigo: teste em 2 etapas para achar a causa de um 401
      const usuario = prop_('CORREIOS_USUARIO', true);
      const basic = 'Basic ' + Utilities.base64Encode(usuario + ':' + chave);
      const testar = function (caminho, corpo) {
        const r = UrlFetchApp.fetch(CORREIOS_BASE + caminho, {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { 'Authorization': basic }, payload: corpo ? JSON.stringify(corpo) : ''
        });
        const code = r.getResponseCode();
        return code + (code >= 200 && code < 300 ? ' OK' : ' ' + r.getContentText().substring(0, 300));
      };
      const a = testar('/token/v1/autentica', null);
      const b = testar('/token/v1/autentica/cartaopostagem', { numero: prop_('CORREIOS_CARTAO_POSTAGEM', true) });
      saidaDiag_('Correios — teste de credenciais',
        'Usuário: ' + usuario + '\nChave: ' + chave.length + ' caracteres\n\nA) usuário + chave: ' + a + '\nB) usuário + chave + cartão: ' + b);
      if (b.indexOf('20') !== 0) return;
    }

    const codigo = perguntar_('Código SEDEX/PAC para testar (ex.: AB123456789BR):');
    if (!codigo) return;
    const norm = correiosRastrear_(codigo.toUpperCase());
    saidaDiag_('Correios — ' + codigo, {
      statusInterno: statusPorEventos_(norm.eventos),
      previsao: norm.previsao,
      eventos: norm.eventos.map(function (e) { return fmtData_(e.data) + ' | ' + e.codigo + '/' + e.tipo + ' | ' + e.descricao + ' | ' + e.local + ' → ' + classificarEvento_(e); })
    });
  } catch (e) {
    saidaDiag_('Correios — ERRO', e.message + (/403|401/.test(e.message)
      ? '\n→ Confira se a API "Rastro" está liberada para o contrato em cws.correios.com.br' : ''));
  }
}
