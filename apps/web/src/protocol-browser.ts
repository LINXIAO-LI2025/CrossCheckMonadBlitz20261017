import * as protocol from '@crosscheck/protocol';
import * as chain from '@crosscheck/chain/browser';
/** Both browser views consume A's executable packages directly. */
Object.assign(window, { CrossCheckProtocol: protocol, CrossCheckChain: chain });
