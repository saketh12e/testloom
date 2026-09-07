const money = cents => `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const byId = id => document.getElementById(id);
let queue = Promise.resolve();

function render(cart) {
  if (!byId('products').children.length) {
    for (const product of cart.products) {
      const card = document.createElement('article');
      card.className = `product ${product.id}`;
      card.innerHTML = `<div class="product-art" aria-hidden="true"><div class="object"></div></div><div class="product-detail"><h3></h3><p></p><button type="button">Add to cart</button></div>`;
      card.querySelector('h3').textContent = product.name;
      card.querySelector('p').textContent = money(product.priceCents);
      const button = card.querySelector('button');
      button.dataset.testid = `add-${product.id}`;
      button.setAttribute('aria-label', `Add ${product.name} to cart`);
      button.addEventListener('click', () => mutate({ action: 'add', productId: product.id }));
      byId('products').append(card);
    }
  }
  const items = byId('cart-items');
  items.replaceChildren();
  if (!cart.items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Your cart is empty. Find your everyday essential.';
    items.append(empty);
  }
  for (const item of cart.items) {
    const row = document.createElement('div');
    row.className = 'cart-item';
    const name = document.createElement('p');
    name.textContent = `${item.name} · ${money(item.priceCents)} each`;
    const label = document.createElement('label');
    label.htmlFor = `quantity-${item.id}`;
    label.textContent = `${item.name} quantity`;
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', min: '0', max: '99', step: '1', value: String(item.quantity), id: label.htmlFor });
    input.dataset.testid = label.htmlFor;
    input.addEventListener('change', () => mutate({ action: 'quantity', productId: item.id, quantity: input.valueAsNumber }));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = `Remove ${item.name}`;
    remove.dataset.testid = `remove-${item.id}`;
    remove.addEventListener('click', () => mutate({ action: 'remove', productId: item.id }));
    row.append(name, label, input, remove);
    items.append(row);
  }
  for (const [id, value] of [['subtotal', cart.subtotalCents], ['discount', cart.discountCents], ['total', cart.totalCents]]) {
    document.querySelector(`[data-testid="${id}"]`).textContent = money(value);
  }
  byId('coupon-error').textContent = cart.error;
  byId('coupon-error').hidden = !cart.error;
  byId('coupon-status').textContent = cart.coupon ? `${cart.coupon} applied.` : '';
}

async function request(input) {
  byId('request-error').hidden = true;
  try {
    const response = await fetch('/api/cart', input ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) } : {});
    const cart = await response.json();
    if (!response.ok) throw new Error(cart.error || 'Could not update your cart.');
    render(cart);
  } catch (error) {
    byId('request-error').textContent = `${error.message} Please try again.`;
    byId('request-error').hidden = false;
  }
}
function mutate(input) { queue = queue.then(() => request(input)); }
byId('coupon-form').addEventListener('submit', event => {
  event.preventDefault();
  mutate({ action: 'coupon', code: byId('coupon').value });
});
byId('reset-cart').addEventListener('click', () => {
  byId('coupon').value = '';
  mutate({ action: 'reset' });
});
queue = request();
