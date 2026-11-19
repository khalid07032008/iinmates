import { BrowserProvider, FetchRequest, JsonRpcProvider, formatEther } from './vendor/ethers.min.js';
import { checkedContract, networks, read, wallet } from './app.js';

const param = new URLSearchParams(location.search).get('chain');
const chainId = param === null ? 4663 : Number(param);
const network = Object.hasOwn(networks, chainId) ? networks[chainId] : null;
const $ = id => document.getElementById(id);
const presets = [...document.querySelectorAll('[data-quantity]')];
let eth, injected;
const bundle = $('mint-bundle-data');
const packaged = bundle && JSON.parse(bundle.textContent);
const registryURL = new URL('/deployments.json', location.href);
const registryKey = 'inmates:published-sale:' + registryURL.pathname;
let registryRequired = !packaged || bundle.dataset.registry === 'required';
if (location.protocol !== 'file:') {
  try { registryRequired ||= localStorage.getItem(registryKey) === 'yes'; } catch { /* Storage is optional. */ }
}
let publicProvider, artifact, address;
artifact = packaged?.artifact;
let account = '', wrongNetwork = false, quote = null, quantity = 1;
let busy = false, waitingForReceipt = false, version = 0, session = 0, notice = '';
let walletHelp = '';
let expiry;

class MintMessage extends Error {}
const amount = wei => wei === 0n ? 'FREE' : formatEther(wei) + ' ETH';

function render() {
  const soon = MINT_STATE === 'soon';
  const live = MINT_STATE === 'live';
  const capacity = quote ? Number(quote.capacity) : 0;
  if (quote) quantity = Math.min(quantity, Math.max(1, capacity));
  const closed = quote && !quote.open;
  const soldOut = quote && quote.issued === quote.max;
  const total = quote ? amount(quote.price * BigInt(quantity)) + ' + gas' : '—';
  const heading = soon ? ['FREE MINT', 'COMING SOON.'] :
    closed || soldOut ? ['MINT', soldOut ? 'SOLD OUT.' : 'CLOSED.'] :
    live && quote ? ['MINT', 'LIVE'] : ['INMATES', 'MINT.'];
  $('mintHeading').replaceChildren(heading[0], document.createElement('br'), heading[1]);
  const state = soon ? 'Mint coming soon' : !live ? 'Mint unavailable' :
    closed ? 'Mint closed' : soldOut ? 'Sold out' : quote ? 'Mint live' : 'Mint';
  $('saleLine').textContent = walletHelp || state + (network ? ' on ' + network.name : '') + '.';
  $('network').textContent = network?.name || 'Unsupported network';
  $('priceLabel').textContent = soon && !quote ? 'Coming soon' : 'Price per NFT';
  $('price').textContent = quote ? amount(quote.price) : soon ? 'Free mint' : 'Unavailable';
  $('total').textContent = total;
  $('supplyTotal').textContent = quote ? String(quote.max) : '999';
  $('mintedCount').textContent = quote ? String(quote.issued) : '';
  $('supplyDetails').textContent = quote ? ' / ' + quote.max + ' minted · ' +
    (quote.max - quote.issued) + ' available' : wrongNetwork ? 'Select Mint to switch your wallet to this network.' :
    notice || 'Live availability unavailable';
  const progress = $('mintProgress');
  if (quote && quote.max > 0n) {
    progress.max = Number(quote.max);
    progress.value = Number(quote.issued);
  } else {
    progress.removeAttribute('value');
  }
  $('quantityNote').textContent = quote ? 'Up to ' + quote.batch + ' per transaction' : 'Choose your mint amount';
  $('qty').value = quantity;
  $('minus').disabled = busy || !capacity || quantity <= 1;
  $('plus').disabled = busy || quantity >= capacity;
  for (const b of presets) {
    const n = Number(b.dataset.quantity);
    b.disabled = busy || n > capacity;
    b.classList.toggle('selected', n === quantity && n <= capacity);
    b.setAttribute('aria-pressed', String(n === quantity && n <= capacity));
  }
  const needsWallet = wrongNetwork || !account;
  $('mint').disabled = busy || !live || !network || closed || soldOut;
  $('headerconnect').textContent = account ? account.slice(0, 6) + '…' + account.slice(-4) : 'Connect Wallet';
  $('headerconnect').disabled = busy || !network;
  $('walletstatus').textContent = notice;
}

function select(n) {
  if (!busy && quote && n >= 1 && BigInt(n) <= quote.capacity) {
    quantity = n;
    render();
  }
}
$('minus').onclick = () => select(quantity - 1);
$('plus').onclick = () => select(quantity + 1);
presets.forEach(b => b.onclick = () => select(Number(b.dataset.quantity)));

function discoverWallet() {
  const provider = window.ethereum;
  if (eth || typeof provider?.request !== 'function') return;
  eth = provider;
  injected = new BrowserProvider(eth, 'any', { cacheTimeout: -1 });
  eth.on?.('accountsChanged', resetWallet);
  eth.on?.('chainChanged', resetWallet);
  eth.on?.('disconnect', resetWallet);
}

async function identifyWallet() {
  discoverWallet();
  if (!eth) return { account: '', wrongNetwork: false };
  const [accounts, id] = await Promise.all([
    eth.request({ method: 'eth_accounts' }), eth.request({ method: 'eth_chainId' })
  ]);
  return { account: accounts[0] || '', wrongNetwork: Number(id) !== chainId };
}

function rpc() {
  if (!publicProvider) {
    const url = new FetchRequest(network.rpc);
    url.timeout = 10000;
    publicProvider = new JsonRpcProvider(url, chainId, {
      staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1
    });
  }
  return publicProvider;
}

async function deploymentRecords() {
  if (!packaged) return read('/deployments.json');
  if (location.protocol === 'file:') return packaged.records;
  const problem = new MintMessage('Could not verify the website’s mint status. Retry in a moment.');
  let response;
  try { response = await fetch(registryURL, { cache: 'no-store', signal: AbortSignal.timeout(8000) }); }
  catch { throw problem; }
  // A host serving only index.html may return a 404 or rewrite this URL to the same page.
  // Once a registry is published it remains authoritative, including when it becomes unavailable.
  if (response.status === 404 && !registryRequired) return packaged.records;
  if (!response.ok) throw problem;
  const body = await response.text();
  if (!registryRequired && /^\s*<!doctype html/i.test(body) && body.includes('id="mint-bundle-data"')) return packaged.records;
  let records;
  try { records = JSON.parse(body); } catch { throw problem; }
  if (!records || Array.isArray(records) || typeof records !== 'object') throw problem;
  if (!registryRequired) {
    registryRequired = true;
    try { localStorage.setItem(registryKey, 'yes'); } catch { /* Keep the in-page guard. */ }
  }
  return records;
}

async function saleRecord() {
  const records = await deploymentRecords();
  const entry = records[chainId];
  if (!entry?.address) throw new MintMessage('No deployment registered on ' + network.name + '.');
  const expected = address || packaged?.records[chainId]?.address;
  if (expected && entry.address.toLowerCase() !== expected.toLowerCase()) {
    throw new MintMessage('The deployment record changed. Reload to verify the current contract.');
  }
  address = entry.address;
  return entry;
}

async function readQuote(provider) {
  const entry = await saleRecord();
  artifact ??= await read('/Inmates.json');
  if (Number(await provider.send('eth_chainId', [])) !== chainId) {
    throw new MintMessage('The provider is on the wrong network. Select ' + network.name + '.');
  }
  const contract = await checkedContract(provider, address, artifact);
  // Pin reads to one block so price, issued supply and limits describe the same state.
  const blockTag = await provider.send('eth_blockNumber', []);
  const [price, issued, max, batch] = await Promise.all([
    contract.PRICE({ blockTag }), contract.totalSupply({ blockTag }),
    contract.MAX_SUPPLY({ blockTag }), contract.MAX_PER_TX({ blockTag })
  ]);
  if (issued > max || max > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MintMessage('The contract returned inconsistent supply data.');
  }
  const remaining = max - issued;
  return { contract, price, issued, max, batch, capacity: remaining < batch ? remaining : batch,
    open: entry.mintOpen !== false };
}

function displayQuote(next) {
  clearTimeout(expiry);
  quote = next;
  if (quote) expiry = setTimeout(() => { quote = null; render(); }, 20000);
  render();
}

// An older read must never restore a quote after a wallet change or a newer read.
async function refresh(clearNotice = false) {
  if ((busy && !waitingForReceipt) || !network) return;
  const ticket = ++version;
  try {
    const identity = await identifyWallet();
    if (version !== ticket) return;
    account = identity.account;
    wrongNetwork = identity.wrongNetwork;
    if (clearNotice && !busy) notice = '';
    if (wrongNetwork) { displayQuote(null); return; }
    const next = await readQuote(account ? injected : rpc());
    if (version !== ticket) return;
    if (notice === readFailure || notice.startsWith('No deployment registered on ') ||
        notice.startsWith('Could not verify the website’s mint status')) notice = '';
    displayQuote(next);
  } catch (err) {
    if (version !== ticket) return;
    notice = err instanceof MintMessage ? err.message : readFailure;
    displayQuote(null);
  }
}
const readFailure = 'Could not verify the contract and mint details. Retrying…';

function describe(err, abi) {
  if (err instanceof MintMessage) return err.message;
  if (err.code === 4001 || err.code === 'ACTION_REJECTED') return 'Wallet request cancelled.';
  if (err.code === 'INSUFFICIENT_FUNDS') return 'Insufficient ETH for the mint total and gas.';
  if (err.code === 'NETWORK_ERROR') return 'Wallet network changed. Check your network and try again.';
  let reason = err.revert?.name;
  const data = err.data ?? err.info?.error?.data;
  if (!reason && abi && typeof data === 'string') {
    try { reason = abi.parseError(data)?.name; } catch { /* Unknown revert selector. */ }
  }
  switch (reason) {
    case 'SoldOut': return 'Sold out for this quantity. Check remaining supply.';
    case 'InvalidQuantity': return 'Quantity exceeds the allowed mint size.';
    case 'WrongPayment': return 'The contract rejected the payment. Review the refreshed price.';
    case 'ERC721InvalidReceiver': return 'This wallet cannot receive the NFT.';
  }
  const detail = [reason, err.reason, err.shortMessage, err.message].filter(Boolean).join(' ');
  if (/wallet.?limit|max.?per.?wallet/i.test(detail)) return 'This wallet has reached its mint limit.';
  if (/not.?live|closed|paused/i.test(detail)) return 'Minting is closed.';
  if (/sold.?out/i.test(detail)) return 'Sold out for this quantity.';
  if (/insufficient funds/i.test(detail)) return 'Insufficient ETH for the mint total and gas.';
  return err.code === 'CALL_EXCEPTION' ? 'The contract rejected this mint. Refresh availability and review the quantity and total.' :
    'Could not complete the wallet request. Check the network and try again.';
}

function showTx(hash, label) {
  const link = document.createElement('a');
  link.href = network.explorer + '/tx/' + hash;
  link.textContent = hash;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  $('transaction').replaceChildren(label + ' ', link);
  $('transaction').hidden = false;
}

async function act(fn) {
  if (busy || !network) return;
  busy = true;
  ++version;
  notice = '';
  render();
  try { await fn(); }
  catch (err) { notice = describe(err, quote?.contract.interface); }
  finally { busy = false; waitingForReceipt = false; render(); await refresh(); }
}

function prepareWallet() { return act(async () => {
  discoverWallet();
  walletHelp = '';
  try {
    if (!eth) throw new MintMessage('Enable your Ethereum wallet for this site, then select Mint again.');
    await wallet(chainId);
  } catch (err) {
    walletHelp = describe(err);
    throw err;
  }
  notice = 'Review the mint total, then select Mint.';
}); }
$('headerconnect').onclick = prepareWallet;

async function verifySender(expected, initialSession) {
  const current = await identifyWallet();
  if (current.wrongNetwork || !current.account || current.account.toLowerCase() !== expected.toLowerCase() ||
      initialSession !== session) {
    throw new MintMessage('Wallet or network changed. Review the mint again.');
  }
}

$('mint').onclick = () => {
  if ($('mint').disabled || MINT_STATE !== 'live') return;
  if (wrongNetwork || !account) return prepareWallet();
  if (!quote) return act(async () => {
    notice = 'Checking the contract. Confirm your wallet is connected to ' + network.name + '.';
    render();
    const next = await readQuote(injected);
    displayQuote(next);
    if (!next.open) throw new MintMessage('Minting is closed.');
    if (next.capacity === 0n) throw new MintMessage('Sold out.');
    notice = 'Mint details verified. Select Mint again to review the transaction.';
  });
  const count = quantity, previousPrice = quote.price, sender = account, initialSession = session;
  return act(async () => {
    displayQuote(null);
    notice = 'Checking the contract price, availability and gas…';
    render();
    await verifySender(sender, initialSession);
    const next = await readQuote(injected);
    await verifySender(sender, initialSession);
    displayQuote(next);
    if (!next.open) throw new MintMessage('Minting is closed.');
    if (count > next.capacity) throw new MintMessage(next.capacity === 0n ? 'Sold out.' :
      'Only ' + next.capacity + ' can be minted in one transaction now. Review your quantity.');
    if (next.price !== previousPrice) throw new MintMessage('Mint price changed. Review the new total and click Mint again.');
    const signed = next.contract.connect(await injected.getSigner(sender));
    const value = next.price * BigInt(count);
    const txOptions = { value, chainId };
    try { await signed.mint.estimateGas(count, txOptions); }
    catch (err) { throw new MintMessage('Gas estimate failed. ' + describe(err, signed.interface)); }
    if ((await saleRecord()).mintOpen === false) {
      displayQuote({ ...next, open: false });
      throw new MintMessage('Minting is closed.');
    }
    await verifySender(sender, initialSession);
    notice = 'Review the mint of ' + count + ' for ' + amount(value) + ' plus gas in your wallet.';
    render();
    const tx = await signed.mint(count, txOptions);
    showTx(tx.hash, 'Submitted.');
    waitingForReceipt = true;
    notice = 'Waiting for confirmation…';
    render();
    try {
      const receipt = await tx.wait(1, 180000);
      showTx(tx.hash, receipt?.status === 1 ? 'Mint confirmed.' : 'Mint failed.');
    } catch (err) {
      if (err.code === 'TRANSACTION_REPLACED') {
        const confirmed = !err.cancelled && err.receipt?.status === 1;
        showTx(err.replacement.hash, confirmed ? 'Mint confirmed.' : 'Transaction replaced. Check the receipt.');
      } else {
        showTx(tx.hash, err.receipt?.status === 0 ? 'Mint reverted.' : 'Submitted. Check confirmation in the explorer.');
      }
    }
    notice = '';
  });
};

function resetWallet() {
  ++session;
  ++version;
  account = '';
  wrongNetwork = false;
  walletHelp = '';
  notice = '';
  displayQuote(null);
  void refresh();
}
window.addEventListener('ethereum#initialized', () => { discoverWallet(); void refresh(true); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void refresh(true);
});
if (!network) notice = 'Unsupported chain in the URL. Open the mint on a configured Robinhood network.';
async function poll() {
  if (!document.hidden) await refresh();
  setTimeout(poll, 8000);
}
render();
void poll();
