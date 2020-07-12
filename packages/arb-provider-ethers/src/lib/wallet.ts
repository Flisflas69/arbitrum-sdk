/*
 * Copyright 2019-2020, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-env node */
'use strict'

import { L2Transaction } from './message'
import { ArbProvider } from './provider'
import { GlobalInbox } from './abi/GlobalInbox'
import { ArbSysFactory } from './abi/ArbSysFactory'
import * as Hashing from './hashing'

import * as ethers from 'ethers'

const ARB_SYS_ADDRESS = '0x0000000000000000000000000000000000000064'

export class ArbWallet extends ethers.Signer {
  public signer: ethers.Signer
  public provider: ArbProvider
  public globalInboxCache?: GlobalInbox
  public seqCache?: number
  public pubkey?: string

  constructor(signer: ethers.Signer, provider: ArbProvider) {
    super()
    this.signer = signer
    this.provider = provider
    this.seqCache = undefined
    this.pubkey = undefined
  }

  public async generateSeq(): Promise<number> {
    if (!this.seqCache) {
      const seq = await this.provider.getTransactionCount(
        await this.getAddress()
      )
      this.seqCache = seq
      return seq
    }
    return this.seqCache
  }

  public async generateAndIncrementSeq(): Promise<number> {
    if (!this.seqCache) {
      const seq = await this.provider.getTransactionCount(
        await this.getAddress()
      )
      this.seqCache = seq + 1
      return seq
    }
    const currentSeq = this.seqCache
    this.seqCache = currentSeq + 1
    return currentSeq
  }

  public incrementSeq(): void {
    if (this.seqCache === undefined) {
      throw Error('Sequence number must have already been generated')
    }
    this.seqCache++
  }

  public async globalInboxConn(): Promise<GlobalInbox> {
    if (!this.globalInboxCache) {
      const globalInbox = await this.provider.globalInboxConn()
      const linkedGlobalInbox = globalInbox.connect(this.signer)
      this.globalInboxCache = linkedGlobalInbox
      return linkedGlobalInbox
    }
    return this.globalInboxCache
  }

  public getAddress(): Promise<string> {
    return this.signer.getAddress()
  }

  public signMessage(message: ethers.utils.Arrayish | string): Promise<string> {
    return this.signer.signMessage(message)
  }

  public async withdrawEthFromChain(
    value: ethers.utils.BigNumberish
  ): Promise<ethers.providers.TransactionResponse> {
    const valueNum = ethers.utils.bigNumberify(value)
    const arbsys = ArbSysFactory.connect(ARB_SYS_ADDRESS, this)
    return arbsys.withdrawEth(await this.getAddress(), valueNum)
  }

  public async withdrawEth(): Promise<ethers.providers.TransactionResponse> {
    const globalInbox = await this.globalInboxConn()
    return globalInbox.withdrawEth()
  }

  public async withdrawERC20(
    erc20: string
  ): Promise<ethers.providers.TransactionResponse> {
    const globalInbox = await this.globalInboxConn()
    return globalInbox.withdrawERC20(erc20)
  }

  public async withdrawERC721(
    erc721: string,
    tokenId: ethers.utils.BigNumberish
  ): Promise<ethers.providers.TransactionResponse> {
    const globalInbox = await this.globalInboxConn()
    return globalInbox.withdrawERC721(erc721, tokenId)
  }

  public async depositERC20(
    to: string,
    erc20: string,
    value: ethers.utils.BigNumberish
  ): Promise<ethers.providers.TransactionResponse> {
    const sendValue = ethers.utils.bigNumberify(value)
    const chain = await this.provider.getVmID()
    const globalInbox = await this.globalInboxConn()
    const tx = await globalInbox.depositERC20Message(
      chain,
      erc20,
      to,
      sendValue
    )
    return this.provider._wrapTransaction(tx, tx.hash)
  }

  public async depositERC721(
    to: string,
    erc721: string,
    tokenId: ethers.utils.BigNumberish
  ): Promise<ethers.providers.TransactionResponse> {
    const chain = await this.provider.getVmID()
    const globalInbox = await this.globalInboxConn()
    const tx = await globalInbox.depositERC721Message(
      chain,
      erc721,
      to,
      tokenId
    )
    return this.provider._wrapTransaction(tx, tx.hash)
  }

  public async depositETH(
    to: string,
    value: ethers.utils.BigNumberish
  ): Promise<ethers.providers.TransactionResponse> {
    const chain = await this.provider.getVmID()
    const globalInbox = await this.globalInboxConn()
    const tx = await globalInbox.depositEthMessage(chain, to, { value })
    return this.provider._wrapTransaction(tx, tx.hash)
  }

  public async transferPayment(
    originalOwner: string,
    newOwner: string,
    nodeHash: string,
    messageIndex: ethers.utils.BigNumberish
  ): Promise<ethers.providers.TransactionResponse> {
    const msgIndex = ethers.utils.bigNumberify(messageIndex)
    const globalInbox = await this.globalInboxConn()
    const tx = await globalInbox.transferPayment(
      originalOwner,
      newOwner,
      nodeHash,
      msgIndex
    )
    return tx
  }
  public async sendTransactionMessage(
    l2tx: L2Transaction
  ): Promise<ethers.providers.TransactionResponse> {
    const vmId = await this.provider.getVmID()
    const from = await this.getAddress()
    try {
      if (this.provider.aggregator) {
        const arbTxHash = l2tx.messageID(from)
        const batchTxHash = l2tx.batchHash(vmId)

        const messageHashBytes = ethers.utils.arrayify(batchTxHash)
        const sig = await this.signer.signMessage(messageHashBytes)

        if (!this.pubkey) {
          this.pubkey = ethers.utils.recoverPublicKey(
            ethers.utils.arrayify(ethers.utils.hashMessage(messageHashBytes)),
            sig
          )
        }

        this.provider.aggregator.sendTransaction(
          l2tx.destAddress,
          l2tx.sequenceNum,
          l2tx.payment,
          l2tx.calldata,
          this.pubkey,
          sig
        )

        const tx: ethers.utils.Transaction = {
          data: l2tx.calldata,
          from: from,
          gasLimit: ethers.utils.bigNumberify(1),
          gasPrice: ethers.utils.bigNumberify(1),
          hash: arbTxHash,
          nonce: l2tx.sequenceNum.toNumber(),
          to: l2tx.destAddress,
          value: l2tx.payment,
          chainId: this.provider.chainId,
        }
        return this.provider._wrapTransaction(tx, arbTxHash)
      } else {
        const globalInbox = await this.globalInboxConn()
        const tx = await globalInbox.sendL2Message(vmId, l2tx.asData())
        const tx2 = this.provider._wrapTransaction(tx, tx.hash)
        return tx2
      }
    } catch (err) {
      if (this.seqCache) {
        this.seqCache -= 1
      }
      throw err
    }
  }

  public async sendTransaction(
    transaction: ethers.providers.TransactionRequest
  ): Promise<ethers.providers.TransactionResponse> {
    const gasLimit = await transaction.gasLimit
    if (!gasLimit) {
      throw Error('must specify gas limit')
    }
    const gasPrice = await transaction.gasPrice
    if (!gasPrice) {
      throw Error('must specify gas price')
    }
    const seq = await this.generateAndIncrementSeq()
    const tx = new L2Transaction(
      gasLimit,
      gasPrice,
      seq,
      await transaction.to,
      await transaction.value,
      await transaction.data
    )
    return this.sendTransactionMessage(tx)
  }
}
