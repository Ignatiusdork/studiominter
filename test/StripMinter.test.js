const {
	Client,
	AccountId,
	PrivateKey,
	AccountCreateTransaction,
	Hbar,
	ContractCreateFlow,
	AccountInfoQuery,
	TransferTransaction,
	ContractInfoQuery,
	ContractFunctionParameters,
	HbarUnit,
	ContractExecuteTransaction,
	TokenId,
	ContractId,
	ContractCallQuery,
	TokenAssociateTransaction,
	CustomRoyaltyFee,
	CustomFixedFee,
	TokenCreateTransaction,
	TokenType,
	TokenSupplyType,
	TokenMintTransaction,
	NftId,
} = require('@hashgraph/sdk');
const fs = require('fs');
const Web3 = require('web3');
const web3 = new Web3();
const { expect } = require('chai');
const { describe, it } = require('mocha');

require('dotenv').config();

// Get operator from .env file
const operatorKey = PrivateKey.fromString(process.env.PRIVATE_KEY);
const operatorId = AccountId.fromString(process.env.ACCOUNT_ID);
const contractName = 'StripMinter';
const env = process.env.ENVIRONMENT ?? null;

const MINT_PAYMENT = process.env.MINT_PAYMENT || 50;

const addressRegex = /(\d+\.\d+\.[1-9]\d+)/i;

// reused variable
let contractId;
let contractAddress;
let abi;
let client, clientAlice;
let alicePK, aliceId;
let tokenId, wlTokenId;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

describe('Deployment: ', function() {
	it('Should deploy the contract and setup conditions', async function() {
		if (contractName === undefined || contractName == null) {
			console.log('Environment required, please specify CONTRACT_NAME for ABI in the .env file');
			process.exit(1);
		}
		if (operatorKey === undefined || operatorKey == null || operatorId === undefined || operatorId == null) {
			console.log('Environment required, please specify PRIVATE_KEY & ACCOUNT_ID in the .env file');
			process.exit(1);
		}

		console.log('\n-Using ENIVRONMENT:', env);

		if (env.toUpperCase() == 'TEST') {
			client = Client.forTestnet();
			clientAlice = Client.forTestnet();
			console.log('testing in *TESTNET*');
		}
		else if (env.toUpperCase() == 'MAIN') {
			client = Client.forMainnet();
			clientAlice = Client.forMainnet();
			console.log('testing in *MAINNET*');
		}
		else {
			console.log('ERROR: Must specify either MAIN or TEST as environment in .env file');
			return;
		}

		client.setOperator(operatorId, operatorKey);
		// deploy the contract
		console.log('\n-Using Operator:', operatorId.toString());

		const json = JSON.parse(fs.readFileSync(`./artifacts/contracts/${contractName}.sol/${contractName}.json`));

		// import ABI
		abi = json.abi;

		const contractBytecode = json.bytecode;
		const gasLimit = 1200000;

		console.log('\n- Deploying contract...', contractName, '\n\tgas@', gasLimit);

		await contractDeployFcn(contractBytecode, gasLimit);

		console.log(`Contract created with ID: ${contractId} / ${contractAddress}`);

		console.log('\n-Testing:', contractName);

		// create Alice account
		alicePK = PrivateKey.generateED25519();
		aliceId = await accountCreator(alicePK, 200);
		console.log('Alice account ID:', aliceId.toString(), '\nkey:', alicePK.toString());
		clientAlice.setOperator(aliceId, alicePK);

		expect(contractId.toString().match(addressRegex).length == 2).to.be.true;
	});

});

describe('Check SC deployment...', function() {
	it('Check default values are set in Constructor', async function() {
		client.setOperator(operatorId, operatorKey);
		const batchSize = await getSetting('getBatchSize', 'batchSize', 100000);
		expect(Number(batchSize) == 10).to.be.true;
		const [hbarCost] = await getSettings('getCost', 'hbarCost');
		expect(Number(hbarCost) == 0 ).to.be.true;
		const mintEconomics = await getSetting('getMintEconomics', 'mintEconomics');
		expect(mintEconomics[0] == 0 &&
			mintEconomics[1] == 0 &&
			mintEconomics[2] == 20 &&
			mintEconomics[3] == 0 &&
			mintEconomics[4] == 0 &&
			mintEconomics[5] == ZERO_ADDRESS).to.be.true;	
		const mintTiming = await getSetting('getMintTiming', 'mintTiming');
		expect(mintTiming[0] == 0 &&
			mintTiming[1] == 0 &&
			mintTiming[2] == true &&
			mintTiming[3] == 0 &&
			mintTiming[4] == 0 &&
			mintTiming[5] == false).to.be.true;
		const remainingMint = await getSetting('getRemainingMint', 'remainingMint');
		expect(Number(remainingMint) == 0).to.be.true;
		const numMinted = await getSetting('getNumberMintedByAddress', 'numMinted');
		expect(Number(numMinted) == 0).to.be.true;
		const wlNumMinted = await getSetting('getNumberMintedByWlAddress', 'wlNumMinted');
		expect(Number(wlNumMinted) == 0).to.be.true;
	});

	it('Initialise the minter for a token with no Fees to check it works', async function() {
		const metadataList = ['metadata.json'];

		// set metadata seperately
		const [success, totalLoaded] = await uploadMetadata(metadataList);
		expect(success).to.be.equal('SUCCESS');
		expect(totalLoaded == 1).to.be.true;

		const royaltyList = [];

		const [result, tokenAddressSolidity] = await initialiseNFTMint(
			'MC-test',
			'MCt',
			'MC testing memo',
			'ipfs://bafybeihbyr6ldwpowrejyzq623lv374kggemmvebdyanrayuviufdhi6xu/',
			royaltyList,
			0,
		);

		tokenId = TokenId.fromSolidityAddress(tokenAddressSolidity);
		console.log('Token Created:', tokenId.toString(), ' / ', tokenAddressSolidity);
		expect(tokenId.toString().match(addressRegex).length == 2).to.be.true;
		expect(result).to.be.equal('SUCCESS');
	});

	it('Cannot add more metadata - given no capacity', async function() {
		client.setOperator(operatorId, operatorKey);
		let errorCount = 0;
		try {
			const [result, resultObj] = await useSetterStringArray('addMetadata', ['meta1', 'meta2']);
			expect(result).to.be.equal('SUCCESS');
			expect(Number(resultObj['totalLoaded']) == 2).to.be.true;
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Can add more metadata - given spare capacity', async function() {
		client.setOperator(operatorId, operatorKey);
		let errorCount = 0;
		try {
			await useSetterStringArray('addMetadata', ['meta1', 'meta2']);
		}
		catch (err) {
			errorCount++;
		}
		try {
			await useSetterStringArray('addMetadata', ['meta1']);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(2);
	});

	it('Owner cannot set batch size to bad values', async function() {
		client.setOperator(operatorId, operatorKey);
		let errorCount = 0;
		try {
			await useSetterInts('updateBatchSize', 0);
		}
		catch (err) {
			errorCount++;
		}
		try {
			await useSetterInts('updateBatchSize', 11);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(2);
	});

	it('Owner can update batch value if needed', async function() {
		client.setOperator(operatorId, operatorKey);
		const [status, resultObj] = await useSetterInts('updateBatchSize', 10);
		expect(status).to.be.equal('SUCCESS');
		expect(Boolean(resultObj['changed'])).to.be.false;

	});

	it('Owner can get metadata', async function() {
		client.setOperator(operatorId, operatorKey);
		const [status, results] = await useSetterInts('getMetadataArray', 0, 10);
		const metadataList = results['metadataList'];
		expect(metadataList[0] == '001_metadata.json').to.be.true;
		expect(status).to.be.equal('SUCCESS');
	});

	it('Fail to update metadata with bad offset', async function() {
		client.setOperator(operatorId, operatorKey);
		let errorCount = 0;
		try {
			await updateMetadataAtOffset('updateMetadataArray', ['meta1', 'meta2'], 500);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});
	
	it('Successfully update metadata', async function() {
		client.setOperator(operatorId, operatorKey);
		const metadataList = [];

		for (let m = 66; m <= 78; m++) {
			const num = '' + m;
			metadataList.push(num.padStart(3, '0') + '_metadata.json');
		}

		await updateMetadataAtOffset('updateMetadataArray', metadataList, 66, 2000000);
	});

	it('Successfully update CID', async function() {
		client.setOperator(operatorId, operatorKey);
		const result = await useSetterString('updateCID', 'ipfs://bafybeibiedkt2qoulkexsl2nyz5vykgyjapc5td2fni322q6bzeogbp5ge/');
		expect(result).to.be.equal('SUCCESS');
	});
});

describe('Check access control permission...', function() {

	it('Check Alice cannot modify the WL', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterAddresses('addToWhitelist', [aliceId]);
		}
		catch (err) {
			errorCount++;
		}

		try {
			await useSetterAddresses('removeFromWhitelist', [aliceId]);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(2);
	});

	it('Check Alice cannot modify the CID/metadata', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterString('updateCID', 'newCIDstring');
		}
		catch (err) {
			errorCount++;
		}

		try {
			await updateMetadataAtOffset('updateMetadataArray', ['meta1', 'meta2'], 0);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(2);
	});

	it('Check Alice cannot retrieve the unminted metadata', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await getSetting('getMetadataArray', 'metadataList');
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the cost', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateCost', 1, 1);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot update the wlToken', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterAddress('updateWlToken', wlTokenId.toSolidityAddress());
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the batch sizing', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateBatchSize', 5);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the Lazy Burn Precentage', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateLazyBurnPercentage', 1);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the max mint', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateMaxMint', 1);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the cooldown timer', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateCooldown', 4);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the start date', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateMintStartTime', (new Date().getTime() / 1000) + 30);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify the pause status', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			// using a dummy value [check onece testnet resets if still passes]
			await useSetterBool('updatePauseStatus', false);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot modify flag to spend lazy from contract', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			// using a dummy value [check onece testnet resets if still passes]
			await useSetterBool('updateContractPaysLazy', false);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot turn on WL', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterBool('updateWlOnlyStatus', true);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot adjust max mint for WL addresses', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('setMaxWlAddressMint', 2);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot adjust max mints per wallet', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('updateMaxMintPerWallet', 2);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot enable buying WL with $LAZY', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await useSetterInts('setBuyWlWithLazy', 1);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check Alice cannot get details of who minted', async function() {
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await methodCallerNoArgs('getNumberMintedByAllAddresses');
		}
		catch (err) {
			errorCount++;
		}
		try {
			await methodCallerNoArgs('getNumberMintedByAllWlAddresses');
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(2);
	});
});

describe('Basic interaction with the Minter...', function() {
	it('Associate the token to Operator', async function() {
		client.setOperator(operatorId, operatorKey);
		const result = await associateTokenToAccount(operatorId, tokenId);
		expect(result).to.be.equal('SUCCESS');
		// Alice will use auto asociation
	});

	it('Check unable to mint if contract paused (then unpause)', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 1);
		await useSetterBool('updatePauseStatus', true);

		let errorCount = 0;
		try {
			await mintNFT(1, tinybarCost);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);

		// unpause the contract
		await useSetterBool('updatePauseStatus', false);
	});

	it('Mint a token from the SC for hbar', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 0);

		// let Alice mint to test it works for a 3rd party
		client.setOperator(aliceId, alicePK);
		const [success, serials] = await mintNFT(1, tinybarCost);
		expect(success == 'SUCCESS').to.be.true;
		expect(serials.length == 1).to.be.true;
	});

	it('Mint 19 tokens from the SC for hbar', async function() {
		client.setOperator(operatorId, operatorKey);
		// unpause the contract
		await useSetterBool('updatePauseStatus', false);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 0);

		const toMint = 19;

		// let Alice mint to test it works for a 3rd party
		client.setOperator(aliceId, alicePK);
		const [success, serials] = await mintNFT(toMint, tinybarCost * toMint, client, 4000000);
		expect(success == 'SUCCESS').to.be.true;
		expect(serials.length == toMint).to.be.true;
	});

	it('Check concurrent mint...', async function() {
		client.setOperator(operatorId, operatorKey);
		// unpause the contract
		await useSetterBool('updatePauseStatus', false);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 0);
		let loop = 10;
		const promiseList = [];
		while (loop > 0) {
			promiseList.push(mintNFT(1, tinybarCost, client));
			await sleep(125);
			promiseList.push(mintNFT(1, tinybarCost, clientAlice));
			await sleep(125);
			loop--;
		}

		let sumSerials = 0;
		await Promise.all(promiseList). then((results) => {
			for (let i = 0; i < results.length; i++) {
				const [, serialList] = results[i];
				sumSerials += serialList.length;
			}
		});
		expect(sumSerials == 20).to.be.true;
	});

	it('Attempt to mint 2 with max mint @ 1, then mint 1', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 0);
		await useSetterInts('updateMaxMint', 1);

		// let Alice mint to test it works for a 3rd party
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await mintNFT(2, tinybarCost * 2);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);

		// now mint the singleton
		const [success, serials] = await mintNFT(1, tinybarCost);
		expect(success == 'SUCCESS').to.be.true;
		expect(serials.length == 1).to.be.true;

		client.setOperator(operatorId, operatorKey);
		await useSetterInts('updateMaxMint', 20);
	});

	it('Check unable to mint if not enough funds', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(10).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 1);
		// unpause the contract
		await useSetterBool('updatePauseStatus', false);

		// let Alice mint to test it works for a 3rd party
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await mintNFT(1, new Hbar(1).toTinybars);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check unable to mint if not yet at start time', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 1);
		// set start time 4 seconds in future
		await useSetterInts('updateMintStartTime', Math.floor(new Date().getTime() / 1000) + 4);
		client.setOperator(aliceId, alicePK);
		let errorCount = 0;
		try {
			await mintNFT(1, new Hbar(1).toTinybars);
		}
		catch (err) {
			errorCount++;
		}
		expect(errorCount).to.be.equal(1);
	});

	it('Check **ABLE** to mint once start time has passed', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(1).toTinybars();
		await useSetterInts('updateCost', tinybarCost, 1);
		// sleep to ensure past the start time
		const mintTiming = await getSetting('getMintTiming', 'mintTiming');
		const mintStart = Number(mintTiming[1]);
		const now = Math.floor(new Date().getTime() / 1000);
		const sleepTime = Math.max((mintStart - now) * 1000, 0);
		// console.log(mintStart, '\nSleeping to wait for the mint to start...', sleepTime, '(milliseconds)');
		await sleep(sleepTime + 1125);
		client.setOperator(aliceId, alicePK);
		const [success, serials] = await mintNFT(1, tinybarCost);
		expect(success == 'SUCCESS').to.be.true;
		expect(serials.length == 1).to.be.true;
	});
});

describe('Test out refund functions...', function() {
	it('Check anyone can burn NFTs', async function() {
		client.setOperator(operatorId, operatorKey);
		const tinybarCost = new Hbar(1).toTinybars();
		let [status, result] = await useSetterInts('updateCost', tinybarCost, 0);
		expect(status == 'SUCCESS').to.be.true;

		client.setOperator(aliceId, alicePK);
		const [success, serials] = await mintNFT(2, tinybarCost * 2);
		expect(success == 'SUCCESS').to.be.true;
		expect(serials.length == 2).to.be.true;

		client.setOperator(operatorId, operatorKey);
		[status, result] = await methodCallerNoArgs('getNumberMintedByAllAddresses', 600000);
		expect(status == 'SUCCESS').to.be.true;
		const walletList = result['walletList'];
		const numMints = result['numMintedList'];
		let totalMinted = 0;

		// gather total minted
		for (let w = 0; w < walletList.length; w++) {
			totalMinted += Number(numMints[w]);
		}

		// Alice now burns her NFTs
		const serialsAsNum = [];
		for (let s = 0; s < serials.length; s++) {
			serialsAsNum.push(Number(serials[s]));
		}
		client.setOperator(aliceId, alicePK);
		const [txStatus, txResObj] = await useSetterInt64Array('burnNFTs', serialsAsNum);
		expect(txStatus == 'SUCCESS').to.be.true;
		// check supply is now 2 less
		expect(totalMinted == (Number(txResObj['newTotalSupply']) + 2)).to.be.true;
	});

	it('Enable refund (& burn), mint then refund - hbar', async function() {
		expect.fail(0, 1, 'Not implemented');
	});

	it('Enable refund (& burn), mint then refund - lazy', async function() {
		expect.fail(0, 1, 'Not implemented');
	});

	it('Shift to refund (hbar & lazy) but store NFT on refund', async function() {
		expect.fail(0, 1, 'Not implemented');
	});

	it('Check Owner can withdraw NFTs exchanged for refund', async function() {
		expect.fail(0, 1, 'Not implemented');
	});
});
  /**
 * Helper function to create new accounts
 * @param {PrivateKey} privateKey new accounts private key
 * @param {string | number} initialBalance initial balance in hbar
 * @returns {AccountId} the newly created Account ID object
 */

   async function accountCreator(privateKey, initialBalance) {
	const response = await new AccountCreateTransaction()
		.setInitialBalance(new Hbar(initialBalance))
		.setMaxAutomaticTokenAssociations(10)
		.setKey(privateKey.publicKey)
		.execute(client);
	const receipt = await response.getReceipt(client);
	return receipt.accountId;
}
/**
 * Helper function to deploy the contract
 * @param {string} bytecode bytecode from compiled SOL file
 * @param {number} gasLim gas limit as a number
 */
 async function contractDeployFcn(bytecode, gasLim) {
	const contractCreateTx = new ContractCreateFlow()
		.setBytecode(bytecode)
		.setGas(gasLim)

	const contractCreateSubmit = await contractCreateTx.execute(client);
	const contractCreateRx = await contractCreateSubmit.getReceipt(client);
	contractId = contractCreateRx.contractId;
	contractAddress = contractId.toSolidityAddress()
}

/**
 * Helper function to get the current settings of the contract
 * @param {string} fcnName the name of the getter to call
 * @param {string} expectedVar the variable to exeppect to get back
 * @param {number=100000} gasLim allows gas veride
 * @return {*}
 */
// eslint-disable-next-line no-unused-vars
async function getSetting(fcnName, expectedVar, gasLim = 100000) {
	// generate function call with function name and parameters
	const functionCallAsUint8Array = await encodeFunctionCall(fcnName, []);

	// query the contract
	const contractCall = await new ContractCallQuery()
		.setContractId(contractId)
		.setFunctionParameters(functionCallAsUint8Array)
		.setMaxQueryPayment(new Hbar(2))
		.setGas(gasLim)
		.execute(client);
	const queryResult = await decodeFunctionResult(fcnName, contractCall.bytes);
	return queryResult[expectedVar];
}

function encodeFunctionCall(functionName, parameters) {
	const functionAbi = abi.find((func) => func.name === functionName && func.type === 'function');
	console.log(functionAbi);
	const encodedParametersHex = web3.eth.abi.encodeFunctionCall(functionAbi, parameters).slice(2);
	return Buffer.from(encodedParametersHex, 'hex');
}

/**
 * Helper function to get the current settings of the contract
 * @param {string} fcnName the name of the getter to call
 * @param {string} expectedVars the variable to exeppect to get back
 * @return {*} array of results
 */
// eslint-disable-next-line no-unused-vars
async function getSettings(fcnName, ...expectedVars) {
	// check the Lazy Token and LSCT addresses
	// generate function call with function name and parameters
	const functionCallAsUint8Array = await encodeFunctionCall(fcnName, []);

	// query the contract
	const contractCall = await new ContractCallQuery()
		.setContractId(contractId)
		.setFunctionParameters(functionCallAsUint8Array)
		.setMaxQueryPayment(new Hbar(2))
		.setGas(100000)
		.execute(client);
	const queryResult = await decodeFunctionResult(fcnName, contractCall.bytes);
	const results = [];
	for (let v = 0 ; v < expectedVars.length; v++) {
		results.push(queryResult[expectedVars[v]]);
	}
	return results;
}

/**
 * Method top upload the metadata using chunking
 * @param {string[]} metadata
 * @return {[string, Number]}
 */
 async function uploadMetadata(metadata) {
	const uploadBatchSize = 60;
	let totalLoaded = 0;
	let result;
	let status = '';
	for (let outer = 0; outer < metadata.length; outer += uploadBatchSize) {
		const dataToSend = [];
		for (let inner = 0; (inner < uploadBatchSize) && ((inner + outer) < metadata.length); inner++) {
			dataToSend.push(metadata[inner + outer]);
		}
		[status, result] = await useSetterStringArray('addMetadata', dataToSend, 1500000);
		totalLoaded = Number(result['totalLoaded']);
		// console.log('Uploaded metadata:', totalLoaded);
	}

	return [status, totalLoaded];
}

/**
 *
 * @param {string} name
 * @param {string} symbol
 * @param {string} memo
 * @param {string} cid
 * @param {*} royaltyList
 * @param {Number=0} maxSupply
 * @param {Number=1000000} gasLim
 */
async function initialiseNFTMint(name, symbol, memo, cid, royaltyList, maxSupply = 0, gasLim = 1000000) {
	const params = [name, symbol, memo, cid, royaltyList, maxSupply];

	const [initialiseRx, initialiseResults] = await contractExecuteWithStructArgs(contractId, gasLim, 'initialiseNFTMint', params, MINT_PAYMENT);
	return [initialiseRx.status.toString(), initialiseResults['createdTokenAddress'], initialiseResults['maxSupply']] ;
}

async function contractExecuteWithStructArgs(cId, gasLim, fcnName, params, amountHbar, clientToUse = client) {
	// use web3.eth.abi to encode the struct for sending.
	// console.log('pre-encode:', JSON.stringify(params, null, 4));
	const functionCallAsUint8Array = await encodeFunctionCall(fcnName, params);

	const contractExecuteTx = await new ContractExecuteTransaction()
		.setContractId(cId)
		.setGas(gasLim)
		.setFunctionParameters(functionCallAsUint8Array)
		.setPayableAmount(amountHbar)
		.freezeWith(clientToUse)
		.execute(clientToUse);

	// get the results of the function call;
	const record = await contractExecuteTx.getRecord(clientToUse);
	const contractResults = decodeFunctionResult(fcnName, record.contractFunctionResult.bytes);
	const contractExecuteRx = await contractExecuteTx.getReceipt(clientToUse);
	return [contractExecuteRx, contractResults, record];
}

/**
 * Helper function for calling the contract methods
 * @param {ContractId} cId the contract to call
 * @param {number | Long.Long} gasLim the max gas
 * @param {string} fcnName name of the function to call
 * @param {ContractFunctionParameters} params the function arguments
 * @param {string | number | Hbar | Long.Long | BigNumber} amountHbar the amount of hbar to send in the methos call
 * @returns {[TransactionReceipt, any, TransactionRecord]} the transaction receipt and any decoded results
 */
 async function contractExecuteFcn(cId, gasLim, fcnName, params, amountHbar) {
	const contractExecuteTx = await new ContractExecuteTransaction()
		.setContractId(cId)
		.setGas(gasLim)
		.setFunction(fcnName, params)
		.setPayableAmount(amountHbar)
		.execute(client);

	// get the results of the function call;
	const record = await contractExecuteTx.getRecord(client);
	const contractResults = decodeFunctionResult(fcnName, record.contractFunctionResult.bytes);
	// console.log(contractResults);
	const contractExecuteRx = await contractExecuteTx.getReceipt(client);
	return [contractExecuteRx, contractResults, record];
}

/**
 * Decodes the result of a contract's function execution
 * @param functionName the name of the function within the ABI
 * @param resultAsBytes a byte array containing the execution result
 */
 function decodeFunctionResult(initialiseNFTMint, resultAsBytes) {
	const functionAbi = abi.find(func => func.name === initialiseNFTMint);
	console.log(functionAbi);
	const functionParameters = functionAbi.outputs;
	const resultHex = '0x'.concat(Buffer.from(resultAsBytes).toString('hex'));
	const result = web3.eth.abi.decodeParameters(functionParameters, resultHex);
	return result;
}

/**
 * Generic setter caller
 * @param {string} fcnName
 * @param {boolean} value
 * @param {number=} gasLim
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function useSetterBool(fcnName, value, gasLim = 200000) {
	const params = new ContractFunctionParameters()
		.addBool(value);
	const [setterAddressRx, , ] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return setterAddressRx.status.toString();
}

/**
 * Generic setter caller
 * @param {string} fcnName
 * @param {string[]} value
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function useSetterStringArray(fcnName, value, gasLim = 500000) {
	const params = new ContractFunctionParameters()
		.addStringArray(value);
	const [setterAddressRx, setterResults] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return [setterAddressRx.status.toString(), setterResults];
}

/**
 * Generic setter caller
 * @param {string} fcnName
 * @param {...number} values
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function useSetterInts(fcnName, ...values) {
	const gasLim = 800000;
	const params = new ContractFunctionParameters();

	for (let i = 0 ; i < values.length; i++) {
		params.addUint256(values[i]);
	}
	const [setterIntsRx, setterResult] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return [setterIntsRx.status.toString(), setterResult];
}

/**
 * Generic setter caller
 * @param {string} fcnName
 * @param {...number} values
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function useSetterInts(fcnName, ...values) {
	const gasLim = 800000;
	const params = new ContractFunctionParameters();

	for (let i = 0 ; i < values.length; i++) {
		params.addUint256(values[i]);
	}
	const [setterIntsRx, setterResult] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return [setterIntsRx.status.toString(), setterResult];
}

/**
 * Call a methos with no arguments
 * @param {string} fcnName
 * @param {number=} gas
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function methodCallerNoArgs(fcnName, gasLim = 500000) {
	const params = new ContractFunctionParameters();
	const [setterAddressRx, setterResults ] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return [setterAddressRx.status.toString(), setterResults];
}

async function associateTokenToAccount(account, tokenToAssociate) {
	// now associate the token to the operator account
	const associateToken = await new TokenAssociateTransaction()
		.setAccountId(account)
		.setTokenIds([tokenToAssociate])
		.freezeWith(client);

	const associateTokenTx = await associateToken.execute(client);
	const associateTokenRx = await associateTokenTx.getReceipt(client);

	const associateTokenStatus = associateTokenRx.status;

	return associateTokenStatus.toString();
}

/**
 * Generic setter caller
 * @param {string} fcnName
 * @param {string} value
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function useSetterString(fcnName, value) {
	const gasLim = 200000;
	const params = new ContractFunctionParameters()
		.addString(value);
	const [setterAddressRx, , ] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return setterAddressRx.status.toString();
}

/**
 * Generic setter caller
 * @param {string} fcnName
 * @param {string[]} value
 * @param {Number} offset starting point to update the array
 * @returns {string}
 */
// eslint-disable-next-line no-unused-vars
async function updateMetadataAtOffset(fcnName, value, offset = 0, gasLim = 800000) {
	const params = new ContractFunctionParameters()
		.addStringArray(value)
		.addUint256(offset);
	const [setterAddressRx, setterResults] = await contractExecuteFcn(contractId, gasLim, fcnName, params);
	return [setterAddressRx.status.toString(), setterResults];
}
