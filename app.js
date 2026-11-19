import { BrowserProvider, Contract, keccak256 } from './vendor/ethers.min.js';

export const treasury = '0x0ce921C407Dd60d72DB28C4381a50dFfc06d43A2';
export const networks = {
  46630: { name: 'Robinhood Chain Testnet', rpc: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com' },
  4663: { name: 'Robinhood Chain Mainnet', rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' }
};
export async function read(file) {
  const response = await fetch(file, { cache: 'no-store' });
  if (!response.ok) throw Error('Could not load ' + file + '.');
  return response.json();
}
export async function wallet(chainId) {
  const eth = window.ethereum;
  if (!eth) throw Error('Open this page in a browser with an Ethereum wallet extension enabled.');
  await eth.request({ method: 'eth_requestAccounts' });
  const hexId = '0x' + chainId.toString(16);
  if (Number(await eth.request({ method: 'eth_chainId' })) !== chainId) {
    const change = () => eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexId }] });
    try { await change(); }
    catch (err) {
      if (Number(err.code) !== 4902 && Number(err.data?.originalError?.code) !== 4902) throw err;
      const net = networks[chainId];
      await eth.request({ method: 'wallet_addEthereumChain', params: [{
        chainId: hexId, chainName: net.name, rpcUrls: [net.rpc], blockExplorerUrls: [net.explorer],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }
      }] });
      if (Number(await eth.request({ method: 'eth_chainId' })) !== chainId) await change();
    }
  }
  const provider = new BrowserProvider(eth);
  if ((await provider.getNetwork()).chainId !== BigInt(chainId)) throw Error('Select ' + networks[chainId].name + ' in your wallet.');
  return { provider, signer: await provider.getSigner() };
}
export async function checkedContract(provider, address, artifact) {
  const code = await provider.getCode(address);
  if (keccak256(code) !== artifact.runtimeHash) throw Error('The contract at this address does not match the compiled INMATES contract.');
  return new Contract(address, artifact.abi, provider);
}
export function message(err) {
  if (err.code === 4001 || err.code === 'ACTION_REJECTED') return 'Wallet request cancelled.';
  return err.reason || err.shortMessage || err.message || 'Wallet request failed.';
}
export function status(element, text, chainId, hash) {
  element.textContent = text;
  if (hash) {
    const a = document.createElement('a');
    a.href = networks[chainId].explorer + '/tx/' + hash;
    a.textContent = 'View transaction';
    a.target = '_blank'; a.rel = 'noopener';
    element.append(' ', a);
  }
}

