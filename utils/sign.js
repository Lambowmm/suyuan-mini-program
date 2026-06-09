const md5 = require('./md5').md5;

function hasSignValue(value) {
  return value !== '' && value !== undefined && value !== null;
}

function sign(params, secret) {
  var parts = [];
  Object.keys(params || {}).forEach(function(key) {
    if (key !== 'action' && hasSignValue(params[key])) {
      parts.push(key + '=' + params[key]);
    }
  });

  parts.sort();
  return md5(parts.join('&') + '&key=' + secret);
}

module.exports = {
  sign: sign
};
