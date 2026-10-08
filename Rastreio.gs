/**
 * Rastreio.gs — o "coração": pega o resultado da transportadora, calcula o
 * status final, atualiza a linha da planilha e decide se gera alerta.
 */

/**
 * Função pura: recebe a linha atual (obj da planilha) e o resultado normalizado
 * da transportadora; devolve { linha (atualizada), mudou, statusAnterior, statusNovo, descricao }.
 */
function calcularAtualizacao_(o, norm, statusBase, agora, descricaoExtra) {
  const eventos = norm.eventos || [];
  const ultimo = eventos[0] || null;

  // data de postagem = primeiro evento de postagem (ou o evento mais antigo)
  let dataPostagem = null;
  const postagens = eventos.filter(function (e) { return classificarEvento_(e) === 'POSTADO'; });
  if (postagens.length) dataPostagem = postagens[postagens.length - 1].data;
  else if (eventos.length && statusBase !== 'AGUARDANDO_POSTAGEM') dataPostagem = eventos[eventos.length - 1].data;

  const r = aplicarRegrasDePrazo_(statusBase, {
    previsao: norm.previsao,
    dataPostagem: dataPostagem,
    dataUltimoEvento: ultimo ? ultimo.data : null,
    dataVinculo: o['Data vínculo'] || null,
    prazoDias: Number(o['Prazo LI (dias úteis)']) || null,
    semEventosIntermediarios: o['Rota'] === 'MELHOR_ENVIO',
    formaNome: o['Forma de envio'] || ''
  }, agora);

  const novo = r.status;
  const anterior = o['Status código'] || 'NOVO';
  const def = STATUS[novo];

  let fim = agora;
  if (novo === 'ENTREGUE' && ultimo) fim = ultimo.data;
  const diasTransito = dataPostagem ? Math.max(0, Math.round(diasEntre_(dataPostagem, fim))) : '';

  const descricao = descricaoExtra || (ultimo ? ultimo.descricao : (norm.erro || ''));

  o['Status código'] = novo;
  o['Status'] = def.rotulo;
  o['Alerta'] = def.alerta ? def.rotulo : '';
  o['Último evento'] = descricao;
  o['Data último evento'] = ultimo ? new Date(ultimo.data) : '';
  o['Local'] = ultimo ? ultimo.local : '';
  o['Data postagem'] = dataPostagem ? new Date(dataPostagem) : '';
  o['Previsão entrega'] = r.previsao || '';
  o['Dias em trânsito'] = diasTransito;
  o['Finalizado'] = def.final ? 'SIM' : '';
  o['Última verificação'] = new Date(agora);
  o['Observação'] = norm.nota || (norm.erro && !eventos.length ? norm.erro : '');
  if (norm.recebedor) o['Recebido por'] = norm.recebedor;

  return { linha: o, mudou: novo !== anterior, statusAnterior: anterior, statusNovo: novo, descricao: descricao };
}

/** Consulta a transportadora de todas as linhas em aberto. Rodado de hora em hora. */
function atualizarRastreios() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { log_('atualizarRastreios', 'Outra execução em andamento — pulando.'); return; }
  const inicio = Date.now();
  const agora = new Date();
  const tempoOk = function () { return Date.now() - inicio < CONFIG.LIMITE_TEMPO_MS; };

  const alterados = [], historico = [], alertas = [], entregas = [];
  let consultados = 0, erros = 0;

  const registrar = function (o, res) {
    alterados.push(o);
    consultados++;
    if (!res.mudou) return;
    historico.push([agora, o['Pedido LI'], o['Código rastreio'], STATUS[res.statusAnterior] ? STATUS[res.statusAnterior].rotulo : res.statusAnterior,
                    STATUS[res.statusNovo].rotulo, res.descricao]);
    if (STATUS[res.statusNovo].alerta) {
      alertas.push([agora, o['Pedido LI'], o['Cliente'], o['Código rastreio'], o['Rota'], STATUS[res.statusNovo].rotulo,
                    res.descricao, o['Link rastreio'], false, '']);
    }
    if (res.statusNovo === 'ENTREGUE') {
      entregas.push(o);
      if (CONFIG.ATUALIZAR_LI_QUANDO_ENTREGUE) {
        try { liAtualizarSituacao_(o['Pedido LI'], CONFIG.LI_SITUACAO_ENTREGUE); }
        catch (e) { o['Observação'] = 'Entregue, mas falhou ao atualizar LI: ' + e.message; }
      }
    }
  };

  try {
    garantirAbas_();
    const reg = lerEnvios_();
    const abertos = reg.linhas.filter(function (o) { return o['Finalizado'] !== 'SIM'; });
    // quem foi verificado há mais tempo vai primeiro
    abertos.sort(function (a, b) {
      return (a['Última verificação'] ? new Date(a['Última verificação']).getTime() : 0) -
             (b['Última verificação'] ? new Date(b['Última verificação']).getTime() : 0);
    });

    // 1) Envios que passaram da janela máxima → encerra monitoramento com alerta
    const ativos = [];
    abertos.forEach(function (o) {
      // pedido antigo que entrou por chargeback é consultado ao menos uma vez (para ter a prova de entrega)
      const chargebackNovo = o['Chargeback'] && !o['Última verificação'];
      if (!chargebackNovo && o['Data vínculo'] && diasEntre_(o['Data vínculo'], agora) > CONFIG.JANELA_MAX_DIAS) {
        const res = { mudou: o['Status código'] !== 'SEM_CONCLUSAO', statusAnterior: o['Status código'], statusNovo: 'SEM_CONCLUSAO',
                      descricao: 'Mais de ' + CONFIG.JANELA_MAX_DIAS + ' dias sem conclusão — verificar manualmente' };
        o['Status código'] = 'SEM_CONCLUSAO'; o['Status'] = STATUS.SEM_CONCLUSAO.rotulo; o['Alerta'] = STATUS.SEM_CONCLUSAO.rotulo;
        o['Finalizado'] = 'SIM'; o['Última verificação'] = agora;
        registrar(o, res);
      } else {
        ativos.push(o);
      }
    });

    // 1b) Corrige códigos digitados com espaço / sem "BR" e acerta a rota pelo FORMATO do código.
    //     (a forma de envio da LI não basta: um pedido "SEDEX" pode ter ido por Jadlog por causa das medidas)
    const correiosOk = correiosDisponivel_();
    ativos.forEach(function (o) {
      const original = String(o['Código rastreio']);
      const cod = normalizarCodigo_(original);
      const rotaCodigo = decidirRota_(cod, String(o['Forma de envio'] || ''), '', correiosOk);
      const mudouCodigo = cod !== original;
      // código de Jadlog/Melhor Envio é definitivo; código dos Correios começa nos Correios
      // (e só vai ao Melhor Envio pelo fallback abaixo, que fica gravado)
      const precisaRota = !o['Rota'] || mudouCodigo || (rotaCodigo === 'MELHOR_ENVIO' && o['Rota'] !== 'MELHOR_ENVIO');
      if (mudouCodigo || precisaRota) {
        o['Código rastreio'] = cod;
        if (precisaRota) { o['Rota'] = rotaCodigo; o['ID Melhor Envio'] = ''; o['Encontrado via'] = ''; }
        o['Link rastreio'] = linkRastreio_(o['Rota'], cod);
        alterados.push(o);
      }
    });

    // 2) CORREIOS PRIMEIRO (um objeto por chamada).
    //    Se o código não pertence ao nosso contrato (SRO-009) ou não existe nos Correios (SRO-020),
    //    a etiqueta provavelmente foi gerada no Melhor Envio → passa para a busca no Melhor Envio.
    const doCorreios = ativos.filter(function (o) { return o['Rota'] === 'CORREIOS_API'; });
    if (doCorreios.length && !correiosOk) {
      log_('atualizarRastreios/Correios', 'Credenciais CORREIOS_* não configuradas — ' + doCorreios.length + ' envios aguardando.');
    } else {
      for (let i = 0; i < doCorreios.length && tempoOk(); i++) {
        const o = doCorreios[i];
        try {
          const norm = correiosRastrear_(o['Código rastreio']);
          if (norm.eventos.length) {
            o['Encontrado via'] = 'Correios (contrato próprio)';
            o['Enviado por'] = o['Enviado por'] || 'Correios';
            registrar(o, calcularAtualizacao_(o, norm, statusPorEventos_(norm.eventos), agora));
          } else {
            o['Rota'] = 'MELHOR_ENVIO';
            o['Nota busca'] = 'Correios: ' + (norm.erro || 'sem eventos') + ' → buscando no Melhor Envio';
            alterados.push(o);
          }
        } catch (e) {
          erros++;
          o['Observação'] = 'Erro Correios: ' + e.message.substring(0, 200);
          o['Última verificação'] = agora;
          alterados.push(o);
          if (/ 40[13]:/.test(e.message)) { avisarAcessoCorreiosNegado_(e.message); break; }
        }
      }
    }

    // 3) MELHOR ENVIO — inclui os que vieram do fallback dos Correios
    const doMe = ativos.filter(function (o) { return o['Rota'] === 'MELHOR_ENVIO'; });
    const idsUsados = {};
    reg.linhas.forEach(function (o) { if (o['ID Melhor Envio']) idsUsados[String(o['ID Melhor Envio'])] = true; });

    const vincular = function (o, it, via) {
      o['ID Melhor Envio'] = it.id;
      idsUsados[String(it.id)] = true;
      o['Encontrado via'] = via;
      const svc = it.service || {};
      const empresa = (svc.company && svc.company.name) || '';
      o['Enviado por'] = [empresa, svc.name || ''].filter(Boolean).join(' ') || 'Melhor Envio';
      o['Código transportadora'] = it.tracking || it.self_tracking || '';
      // Melhor Rastreio abre com o código da LI (Jadlog 6xxxxxxxx / ME...BR) ou o self_tracking
      const codLink = ehCodigoMelhorEnvio_(o['Código rastreio']) ? o['Código rastreio'] : (it.self_tracking || o['Código transportadora']);
      if (codLink) o['Link rastreio'] = linkRastreio_('MELHOR_ENVIO', codLink);
    };

    // 3a) pelo CÓDIGO: varre a lista de etiquetas do Melhor Envio
    let semId = doMe.filter(function (o) { return !o['ID Melhor Envio']; });
    let buscouCodigo = false;
    const buscouNome = {};
    if (semId.length && tempoOk()) {
      try {
        let menor = agora.getTime();
        semId.forEach(function (o) {
          const d = o['Data pedido'] || o['Data vínculo'];
          if (d) menor = Math.min(menor, new Date(d).getTime());
        });
        const info = {};
        const chaves = [];
        semId.forEach(function (o) { chaves.push(String(o['Código rastreio'])); chaves.push('PEDIDO:' + o['Pedido LI']); });
        const achados = meIndexarEtiquetas_(chaves, new Date(menor - 7 * 86400000), tempoOk, info);
        semId.forEach(function (o) {
          const k = String(o['Código rastreio']).toUpperCase();
          const kp = 'PEDIDO:' + o['Pedido LI'];
          if (achados[k] && !idsUsados[String(achados[k])]) vincular(o, info.itens[k] || { id: achados[k] }, 'Melhor Envio (código)');
          else if (achados[kp] && !idsUsados[String(achados[kp])]) vincular(o, info.itens[kp] || { id: achados[kp] }, 'Melhor Envio (nº do pedido)');
        });
        buscouCodigo = true;
      } catch (e) { erros++; log_('atualizarRastreios/ME', 'Erro na busca por código: ' + e.message); }
    }

    // 3b) pelo NOME DO CLIENTE (último recurso): o nome é o mesmo em qualquer plataforma
    semId = doMe.filter(function (o) { return !o['ID Melhor Envio']; });
    let buscasNome = 0;
    for (let i = 0; i < semId.length && tempoOk() && buscasNome < CONFIG.ME_MAX_BUSCAS_NOME; i++) {
      const o = semId[i];
      if (!o['Cliente']) continue;
      buscasNome++;
      try {
        const it = meBuscarPorNome_(o['Cliente'], o['Data pedido'] || o['Data vínculo'], idsUsados);
        if (it) vincular(o, it, 'Melhor Envio (nome do cliente)');
        buscouNome[o['Chave']] = true;
      } catch (e) { erros++; log_('atualizarRastreios/ME', 'Erro na busca por nome: ' + e.message); }
    }

    // 3c) não achou em lugar nenhum → provavelmente não foi enviado.
    //     Fica "Aguardando postagem" e vira alerta "Não postado" depois de DIAS_SEM_POSTAGEM_ALERTA dias.
    //     A rota volta ao padrão para a busca completa ser refeita na próxima rodada.
    //     (só para quem passou pelas DUAS buscas nesta rodada; o resto tenta de novo na próxima)
    doMe.filter(function (o) { return !o['ID Melhor Envio'] && buscouCodigo && buscouNome[o['Chave']]; }).forEach(function (o) {
      const detalhe = (o['Nota busca'] ? o['Nota busca'].replace(/ → buscando no Melhor Envio$/, '') + ' · ' : '') +
        'Melhor Envio: nada com este código, nº do pedido ou nome do cliente';
      o['Rota'] = decidirRota_(String(o['Código rastreio']), String(o['Forma de envio'] || ''), '', correiosOk);
      o['Nota busca'] = '';
      registrar(o, calcularAtualizacao_(o, { eventos: [], previsao: null, nota: detalhe,
        erro: 'Código não encontrado nos Correios nem no Melhor Envio — conferir se foi digitado certo na LI' }, 'AGUARDANDO_POSTAGEM', agora));
    });

    // 3d) status de todas as etiquetas vinculadas, em lotes de 100
    const comId = doMe.filter(function (o) { return o['ID Melhor Envio']; });
    if (comId.length && tempoOk()) {
      try {
        const status = meStatusLote_(comId.map(function (o) { return String(o['ID Melhor Envio']); }));
        comId.forEach(function (o) {
          const norm = meNormalizar_(status[String(o['ID Melhor Envio'])]);
          if (o['Encontrado via'] === 'Melhor Envio (nome do cliente)') {
            norm.nota = 'Vinculado pelo nome do cliente — conferir. Rastreio real: ' + (o['Código transportadora'] || '?') +
                        ' (' + (o['Enviado por'] || 'Melhor Envio') + ')';
          } else if (o['Código transportadora'] && o['Código transportadora'] !== o['Código rastreio']) {
            norm.nota = 'Rastreio na transportadora: ' + o['Código transportadora'] + ' (' + (o['Enviado por'] || '') + ')';
          } else if (ehCodigoCorreios_(o['Código rastreio'])) {
            norm.nota = 'Etiqueta dos Correios gerada pelo Melhor Envio (fora do contrato próprio)';
          }
          o['Nota busca'] = '';
          let base = statusPorMelhorEnvio_(norm.statusMe, norm.eventos);
          let descricao = descricaoStatusMe_(norm.statusMe);
          // "Não entregue" no ME é genérico: abre o detalhe da etiqueta atrás do motivo real
          if (base === 'PROBLEMA_ENTREGA' && tempoOk()) {
            try {
              const motivo = motivoNoDetalhe_(meDetalhe_(o['ID Melhor Envio']));
              if (motivo) { base = motivo.status; descricao = 'Melhor Envio: ' + motivo.texto; }
            } catch (e) { log_('atualizarRastreios/ME', 'Detalhe da etiqueta ' + o['ID Melhor Envio'] + ': ' + e.message); }
          }
          // entregue: o detalhe da etiqueta pode trazer quem recebeu (consulta uma vez só, na entrega)
          if (base === 'ENTREGUE' && !norm.recebedor && !o['Recebido por'] && tempoOk()) {
            try { norm.recebedor = extrairRecebedor_(meDetalhe_(o['ID Melhor Envio'])); } catch (e) {}
          }
          registrar(o, calcularAtualizacao_(o, norm, base, agora, descricao));
        });
      } catch (e) { erros++; log_('atualizarRastreios/ME', 'Erro: ' + e.message); }
    }
  } finally {
    // grava o que deu tempo de processar, mesmo se algo falhou no meio
    try {
      salvarEnvios_(alterados);
      registrarHistorico_(historico);
      let autoResolvidos = 0;
      try { autoResolvidos = sincronizarAlertas_(lerEnvios_().linhas); } catch (e) { log_('sincronizarAlertas', 'Erro: ' + e.message); }
      registrarAlertas_(alertas);
      try { atualizarResumo(); } catch (e) { log_('atualizarResumo', 'Erro: ' + e.message); }
      enviarEmailRodada_(alertas, entregas);
      log_('atualizarRastreios', 'consultados=' + consultados + ' mudanças=' + historico.length +
           ' alertas=' + alertas.length + ' alertas antigos resolvidos=' + autoResolvidos + ' entregues=' + entregas.length + ' erros=' + erros +
           ' tempo=' + Math.round((Date.now() - inicio) / 1000) + 's');
    } finally {
      lock.releaseLock();
    }
  }
}

/**
 * Quem recebeu um envio já entregue, consultando a transportadora de novo (Correios ou detalhe da etiqueta do ME).
 * Usado quando o pedido entra em chargeback e a entrega é anterior a esta funcionalidade.
 */
function buscarRecebedor_(o) {
  if (o['Rota'] === 'CORREIOS_API' && correiosDisponivel_()) return correiosRastrear_(o['Código rastreio']).recebedor || '';
  if (o['ID Melhor Envio']) return extrairRecebedor_(meDetalhe_(o['ID Melhor Envio']));
  return '';
}

