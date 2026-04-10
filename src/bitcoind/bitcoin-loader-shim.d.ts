declare module "@cogcoin/bitcoin" {
  export function getBitcoindPath(): Promise<string>;
  export function getBitcoinCliPath(): Promise<string>;
}
