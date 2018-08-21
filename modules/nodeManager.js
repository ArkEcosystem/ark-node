'use strict';

var async = require('async');
var schema = require('../schema/nodeManager.js');
var sql = require('../sql/nodeManager.js');
var os = require('os');

var self, library, modules;

var __private = {
	// flag if the node is in sync with network
	blockchainReady: false,

	// delegates keypairs
	keypairs: {}
};

// ## Constructor
function NodeManager (cb, scope) {
	library = scope;
	self = this;
	if(library.config.maxhop){
		__private.maxhop = library.config.maxhop;
	}
	else{
		// TODO: to decrease when bloom filters are implemented
		__private.maxhop = 4;
	}
	setImmediate(cb, null, self);
}



//
//__EVENT__ `onBind`

//
NodeManager.prototype.onBind = function (scope) {
	modules = scope;
};

// ## Main entry point of the node app
//
//
//__API__ `startApp`

//
NodeManager.prototype.startApp = function(){
	library.logger.info("Starting Node Manager");
  library.bus.message('loadDatabase');
}

//
//__EVENT__ `onDatabaseLoaded`

//
NodeManager.prototype.onDatabaseLoaded = function(lastBlock) {
	library.bus.message('startTransactionPool');
	library.bus.message('startBlockchain');

	// Mount the network API
	library.logger.info("Mounting Network API");
	library.bus.message('attachNetworkApi');

	// If configured, mount the public API (not recommanded for forging node on long term).
	// Ideally we should only mount it when node is synced with network
	if(library.config.api.mount){
		library.logger.info("Mounting Public API");
		library.bus.message('attachPublicApi');
	}

	library.logger.info("# Started as a relay node");
	library.bus.message('loadDelegates');
};

//
//__EVENT__ `onBlockchainReady`

//
NodeManager.prototype.onBlockchainReady = function() {
	library.logger.info("Blockchain in sync. Loading delegates");
	library.bus.message('loadDelegates');
}

//
//__EVENT__ `onDelegatesLoaded`

//
NodeManager.prototype.onDelegatesLoaded = function(keypairs) {
  var numberOfDelegates = Object.keys(keypairs).length;
	var loadedPairs = Object.keys(__private.keypairs).length;

	// If there are some delegates configured, start forging, else just relay tx and blocks
  if(numberOfDelegates > 0 && loadedPairs == 0){
		var arch = os.arch()
		if(arch == "x64" || arch == "x86"){
			__private.keypairs=keypairs;
	    library.logger.info("# Loaded "+numberOfDelegates+" delegate(s). Started as a forging node");
	    library.bus.message('startForging');
		}
		else {
			library.logger.info("Your architecture '"+ arch + "' is not supported for forging");
		}

  }
  else{
    if(loadedPairs > 0){
			library.logger.info("No new delegates found in config file");
		}
		else if(numberOfDelegates == 0){
			library.logger.info("No delegates found in config file");
		}
  }

};

//
//__EVENT__ `onNetworkApiAttached`

//
NodeManager.prototype.onNetworkApiAttached = function(){
  library.bus.message('updatePeers');
}

//
//__EVENT__ `onPeersUpdated`

//
NodeManager.prototype.onPeersUpdated = function() {
	library.bus.message('observeNetwork');
};

//
//__EVENT__ `onNetworkObserved`

//
NodeManager.prototype.onNetworkObserved = function(network){
	if(!__private.lastBlock || network.height > __private.lastBlock.height){
		library.bus.message('downloadBlocks', function(err,lastBlock){

		});
	}
}

//
//__EVENT__ `onBlocksReceived`

//
NodeManager.prototype.onBlocksReceived = function(blocks, peer, cb) {
	// we had to pull several blocks from network? means we are not in sync anymore
	if(blocks.length > 0){
		__private.blockchainReady = false;
	}

	library.managementSequence.add(function (mSequence) {

		var currentBlock;
		async.eachSeries(blocks, function (block, eachSeriesCb) {
			block.reward = parseInt(block.reward);
			block.totalAmount = parseInt(block.totalAmount);
			block.totalFee = parseInt(block.totalFee);
			block.verified = false;
			block.processed = false;
			if (block.numberOfTransactions == 0) block.transactions = [];
			block.broadcast = blocks.length == 1;

			// rationale: onBlocksReceived received is called within another thread than onBlockReceived
			// so we prevent from processing blocks we asked for and we received in the between via normal broadcast
			if(block.height <= modules.blockchain.getLastIncludedBlock().height){
				return eachSeriesCb(null, block);
			}

			modules.blockchain.addBlock(block);
			currentBlock=block;
			if(block.height%100 == 0){
				library.logger.info("Processing block height", block.height);
			}
			return library.bus.message('verifyBlock', block, eachSeriesCb);

		}, function(err){
			if(err){
				library.logger.error(err, currentBlock);
				modules.blockchain.removeBlock(currentBlock);
			}

			// we don't deal with download management, just return to say "blocks processed, go ahead"
			return mSequence && mSequence(err, currentBlock);

			// if(!blocks || blocks.length === 0){
			// 	return cb();
			// }
			// else{
			// 	return cb();
			// 	return library.bus.message("downloadBlocks", cb);
			// }

		});

	}, cb);
}

//
//__EVENT__ `onRebuildBlockchain`

//
NodeManager.prototype.onRebuildBlockchain = function(blocksToRemove, state, cb) {
	library.managementSequence.add(function (mSequence) {
		modules.loader.getNetwork(true, function(err, network){
			var lastBlock = modules.blockchain.getLastBlock();
			if(!network || !network.height){
				return mSequence && mSequence("Can't find peers to sync with...");
			}
			else if(network.height > lastBlock.height){
				library.logger.info("Observed network height is higher", {network: network.height, node:lastBlock.height});
				library.logger.info("Rebuilding from network");
				return modules.blocks.removeSomeBlocks(blocksToRemove, mSequence);
			}
			else{
				var bestBlock = modules.loader.getNetworkSmallestBlock();
				//network.height is some kind of "conservative" estimation, so some peers can have bigger height
				if(bestBlock && bestBlock.height > lastBlock.height){
					library.logger.info("Observed network is on same height, but some peers with bigger height", {network: {id: bestBlock.id, height:bestBlock.height}, node:{id: lastBlock.id, height:lastBlock.height}});
					library.logger.info("Rebuilding from network");
					return modules.blocks.removeSomeBlocks(blocksToRemove, mSequence);
				}
				else if(bestBlock && bestBlock.height == lastBlock.height && bestBlock.timestamp < lastBlock.timestamp){
					library.logger.info("Observed network is on same height, but found a block with smaller timestamp", {network: {id: bestBlock.id, height:bestBlock.height}, node:{id: lastBlock.id, height:lastBlock.height}});
					library.logger.info("Rebuilding from network");
					return modules.blocks.removeSomeBlocks(blocksToRemove, mSequence);
				}
				else{
					library.logger.info("Observed network is on same height, and same block timestamp", {network: network.height, node:lastBlock.height});
					return mSequence && mSequence();
				}
			}
		});
	}, cb);
};



//make sure the block transaction list is complete, otherwise try to find transactions
__private.prepareBlock = function(block, peer, cb){

	//RECEIVED empty block?
	if(block.numberOfTransactions == 0){
		return cb && cb(null, block);
	}
	// lets download transactions
	// carefully since order is important to validate block
	else if(block.transactions.length == 0){
		var transactionIds = block.transactionIds;

		// get transactions by id from mempool
		modules.transactionPool.getMissingTransactions(transactionIds, function(err, missingTransactionIds, foundTransactions){
			if(err){
				return cb && cb(err, block);
			}

			// great! All transactions were in mempool lets go!
			if(missingTransactionIds.length==0){
				delete block.transactionIds;
				block.transactions=foundTransactions;
				return cb && cb(null, block);
			}
			// lets download the missing ones from the peer that sent the block.
			else{
				modules.transport.getFromPeer(peer, {
					 method: 'GET',
					api: '/transactionsFromIds?blockid=' + block.id + "&ids='"+missingTransactionIds.join(",")+"'"
				}, function (err, res) {
					library.logger.debug("called "+res.peer.ip+":"+res.peer.port+"/peer/transactionsFromIds");
					 if (err) {
						 library.logger.debug('Cannot get transactions for block', block.id);
						 return cb && cb(null, block);
					 }

					 var receivedTransactions = res.body.transactions;
					 library.logger.debug("received transactions", receivedTransactions.length);

					 for(var i=0;i<transactionIds.length;i++){
						 var id=transactionIds[i];
						 // assume the list may contains null element
						 var tx=receivedTransactions.find(function(tx){return tx?tx.id==id:false});
						 if(tx){
							 transactionIds[i]=tx;
							 modules.transactionPool.addToMempool(tx);
						 }
						 else{
							 tx=foundTransactions.find(function(tx){return tx.id==id});
							 if(!tx.incomplete){
								 transactionIds[i]=tx;
							 }
							 else{
								 // Fucked! we ignore the block waiting for another one to have it complete.
								 return cb && cb("Cannot find all transactions to complete the block", block);
							 }
						 }
					 }

					 // transactionsIds now has the transactions in same order as original block
					 block.transactions = transactionIds;

					 // sanity check everything looks ok
					 if(block.transactions.length==block.numberOfTransactions){
						 //removing useless data
						 delete block.transactionIds;
						 return cb && cb(null, block);
					 }

					 // we should never end up here
					 else{
						 return cb && cb("Block transactions are inconsistant. This is likely a bug, please report.", block);
					 }
				 }
			 );
			}
		});
	}
	else { //block received complete
		return cb && cb(null, block);
	}
}

//
//__API__ `swapLastBlockWith`

//
NodeManager.prototype.swapLastBlockWith = function(block, peer, cb){
	async.waterfall([
		function(seriesCb){
			modules.delegates.validateBlockSlot(block, seriesCb);
		},
		function(data, seriesCb){
			__private.prepareBlock(block, peer, seriesCb);
		},
		function(data, seriesCb){
			return modules.blocks.removeLastBlock(seriesCb);
		},
		function(data, seriesCb){
			delete block.orphaned;
			block.verified = false;
			block.processed = false;
			block.broadcast = true;
			modules.blockchain.addBlock(block);
			library.bus.message("verifyBlock", block, seriesCb);
		}
	], function(err){
		if(err){
			modules.blockchain.removeBlock(block);
		}
		return cb && cb(err, block);
	});
};

//
//__EVENT__ `onBlockReceived`

//
NodeManager.prototype.onBlockReceived = function(block, peer, cb) {
	library.managementSequence.add(function (mSequence) {
		if(!block.ready){
			if(block.orphaned){
				// this lastBlock is processed because of managementSequence.
				var lastBlock = modules.blockchain.getLastBlock();
				// all right we are at the beginning of a fork, let's swap asap if needed
				if(lastBlock && block.timestamp < lastBlock.timestamp){
					// lowest timestamp win: likely more spread
					library.logger.info("Orphaned block has a smaller timestamp, swaping with lastBlock", {id: block.id, height:block.height});
					return self.swapLastBlockWith(block, peer, mSequence);
				}
				else if(lastBlock && block.timestamp == lastBlock.timestamp && block.id < lastBlock.id){
					// same timestamp, lowest id win: double forgery
					library.logger.info("Orphaned block has same timestamp but smaller id, swaping with lastBlock", {id: block.id, height:block.height});
					return self.swapLastBlockWith(block, peer, mSequence);
				}
				else {
					// no swap
					library.logger.info("Orphaned block has a bigger timestamp or bigger id, block disregarded", {id: block.id, height:block.height});
					return mSequence && mSequence(null, block);
				}
			}
			else {
				library.logger.debug("Block disregarded", {id: block.id, height:block.height});
				return mSequence && mSequence(null, block);
			}
		}
		else {
			// First time receiving a block form network? Means we are in sync with network
			if(!__private.blockchainReady){
				__private.blockchainReady=true;
				// using a setImmediate because we don't want to pollute managementSequence thread
				setImmediate(function(){
					library.bus.message("blockchainReady");
				});
			}
			library.logger.info("New block received", {id: block.id, height:block.height, transactions: block.numberOfTransactions, peer:peer.string});
			block.verified = false;
			block.processed = false;
			block.broadcast = true;
			__private.prepareBlock(block, peer, function(err, block){
				if(err){
					modules.blockchain.removeBlock(block);
					return mSequence && mSequence(err, block);
				}
				library.logger.debug("processing block with "+block.transactions.length+" transactions", block.height);
				return library.bus.message('verifyBlock', block, function(err){
					if(err){
						library.logger.error("Error processing block at height", block.height);
					} else {
						modules.blockchain.upsertBlock(block);
					}
					return mSequence && mSequence(err, block);
				});
			});
		}
	}, cb);
};

//
//__EVENT__ `onBlockForged`

//
NodeManager.prototype.onBlockForged = function(block, cb) {
	library.managementSequence.add(function (mSequence) {
		if(!block.ready){
			library.logger.debug("Skip processing block", {id: block.id, height:block.height});
			return mSequence && mSequence(null, block);
		}
		block.verified = true;
		block.forged = true;
	  block.processed = false;
		block.broadcast = true;

		library.logger.info("Processing forged block", block.id);
		library.bus.message('processBlock', block, mSequence);
	}, cb);
}

//
//__EVENT__ `onBlockVerified`

//
NodeManager.prototype.onBlockVerified = function(block, cb) {

	library.bus.message('processBlock', block, cb);
}

//
//__EVENT__ `onBlockProcessed`

//
NodeManager.prototype.onBlockProcessed = function(block, cb) {


	if(block.broadcast){
		library.bus.message('broadcastBlock', block);
	}
	cb && cb(null, block);
}

//
//__EVENT__ `onTransactionsReceived`

//
NodeManager.prototype.onTransactionsReceived = function(transactions, source, cb) {
	library.managementSequence.add(function(mSequence){
		if(!source || typeof source !== "string"){
			mSequence && mSequence("Rejecting not sourced transactions", transactions);
		}
		// node created the transaction so it is safe include it (data integrity and fee is assumed to be correct)
		if(source.toLowerCase() == "api"){
			transactions.forEach(function(tx){
				tx.id = library.logic.transaction.getId(tx);
				tx.broadcast = true;
				tx.hop = 0;
			});

			library.bus.message("addTransactionsToPool", transactions, mSequence);
		}

		// we need sanity check of the transaction list
		else if(source.toLowerCase() == "network"){

			var report = library.schema.validate(transactions, schema.transactions);

			if (!report) {
				return mSequence && mSequence("Transactions list is not conform", transactions);
			}

			var skimmedtransactions = [];
			async.eachSeries(transactions, function (transaction, cb) {
				try {
					transaction = library.logic.transaction.objectNormalize(transaction);
					transaction.id = library.logic.transaction.getId(transaction);
				} catch (e) {
					return cb(e);
				}

				if(!library.logic.transaction.verifyFee(transaction)){
					return cb("Transaction fee is too low");
				}

				library.db.query(sql.getTransactionId, { id: transaction.id }).then(function (rows) {
					if (rows.length > 0) {
						library.logger.debug('Transaction ID is already in blockchain', transaction.id);
					}
					else{ // we only broadcast tx with known hop.
						transaction.broadcast = false;
						if(transaction.hop){
							transaction.hop = parseInt(transaction.hop);
							if(transaction.hop > -1 && transaction.hop < __private.maxhop){
								transaction.hop++;
								transaction.broadcast = true;
							}
						}
						else { // TODO: backward compatibility, to deprecate
							transaction.hop = 1;
							transaction.broadcast = true;
						}
						skimmedtransactions.push(transaction);
					}
					return cb();
				});
			}, function (err) {
				if(err){
					return mSequence && mSequence(err);
				}
				if(skimmedtransactions.length>0){
					library.bus.message("addTransactionsToPool", skimmedtransactions, mSequence);
				}
				else{
					return mSequence && mSequence();
				}
			});

		}
		else {
			library.logger.error("Unknown sourced transactions", source);
			mSequence && mSequence("Rejecting unknown sourced transactions", transactions);
		}
	}, cb);
};

module.exports = NodeManager;
