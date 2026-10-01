/**
 * Http.gs — chamada HTTP com tentativas automáticas (limite de requisições / instabilidade).
 */
function httpJson_(url, opcoes, rotulo) {
  const opts = Object.assign({ muteHttpExceptions: true }, opcoes || {});
  let ultimoErro = '';
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const resp = UrlFetchApp.fetch(url, opts);
    const code = resp.getResponseCode();
    const texto = resp.getContentText();

    if (code >= 200 && code < 300) {
      if (!texto) return {};
      try { return JSON.parse(texto); } catch (e) { return { _texto: texto }; }
    }
    ultimoErro = (rotulo || 'HTTP') + ' ' + code + ': ' + texto.substring(0, 300);

    // 429 = limite de requisições; 5xx = instabilidade → espera e tenta de novo
    if (code === 429 || code >= 500) {
      Utilities.sleep(2000 * tentativa);
      continue;
    }
    // 404 costuma significar "não encontrado" — devolvemos null em vez de quebrar
    if (code === 404) return null;
    break;
  }
  throw new Error(ultimoErro);
}

function montarQuery_(params) {
  if (!params) return '';
  const partes = Object.keys(params)
    .filter(function (k) { return params[k] !== undefined && params[k] !== null && params[k] !== ''; })
    .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); });
  return partes.length ? '?' + partes.join('&') : '';
}
