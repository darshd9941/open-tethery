// Fills <span data-product="name|version"> from site/brand.js (generated from product.json).
(function () {
  var P = window.PRODUCT || { name: 'Pocket Monitor', version: '' };
  var n = document.querySelectorAll('[data-product]');
  for (var i = 0; i < n.length; i++) n[i].textContent = P[n[i].getAttribute('data-product')] || n[i].textContent;
  if (P.name && document.title.indexOf('{name}') > -1) document.title = document.title.replace('{name}', P.name);
})();
