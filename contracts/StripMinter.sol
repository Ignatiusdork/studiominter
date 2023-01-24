// SPDX-License-Identifier: GPL-3.0
pragma solidity >=0.8.12 <0.9.0;

import "./HederaResponseCodes.sol";
import "./HederaTokenService.sol";
import "./KeyHelper.sol";
import "./ExpiryHelper.sol";
import "./IHederaTokenService.sol";

import "./MinterLibrary.sol";
// functionality moved ot library for space saving

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract StripMinter is Ownable, ReentrancyGuard, HederaTokenService, KeyHelper{
	using EnumerableMap for EnumerableMap.AddressToUintMap;
	using EnumerableMap for EnumerableMap.UintToUintMap;
	using EnumerableSet for EnumerableSet.UintSet;

	// list of WL addresses
    EnumerableMap.AddressToUintMap private _whitelistedAddressQtyMap;
	
	string private _cid;
	string[] private _metadata;
	uint private _batchSize;
	uint private _totalMinted;
	uint private _maxSupply;
	// map address to timestamps
	// for cooldown mechanic
	EnumerableMap.AddressToUintMap private _walletMintTimeMap;
	// map serials to timestamps
	// for burn / refund mechanic
	EnumerableMap.UintToUintMap private _serialMintTimeMap;
	// set of the serials used to redeem WL to ensure no double dip
	EnumerableSet.UintSet private _wlSerialsUsed;
	// map WL addresses to the numbers of mints used
	// track WL mints per address for max cap
	EnumerableMap.AddressToUintMap private _wlAddressToNumMintedMap;
	// map ALL addreesses to the numbers of mints used
	// track mints per wallet for max cap
	EnumerableMap.AddressToUintMap private _addressToNumMintedMap;

    struct MintTiming {
		uint lastMintTime;
		uint mintStartTime;
		bool mintPaused;
		uint cooldownPeriod;
		uint refundWindow;
		bool wlOnly;
	}

    struct MintEconomics {	
            
		// in tinybar
		uint mintPriceHbar;
		// adjusted for decimal 1
		uint wlDiscount;
		uint maxMint;
		uint maxWlAddressMint;
		uint maxMintPerWallet;
		address wlToken;
	}

	// to avoid serialisation related default causing odd behaviour
	// implementing custom object as a wrapper
	struct NFTFeeObject {
		uint32 numerator;
		uint32 denominator;
		uint32 fallbackfee;
		address account;
	}

	MintTiming private _mintTiming;
	MintEconomics private _mintEconomics;

	address private _token;
	
	event MinterContractMessage(
		string evtType,
		address indexed msgAddress,
		uint msgNumeric
	);

	constructor(
	
	) {
        _mintEconomics = MintEconomics(0, 0, 20, 0, 0, address(0));
        _mintTiming = MintTiming(0, 0, true, 0, 0, false);   
        _token = address(0);
        _batchSize = 10;
	}

	function initialiseNFTMint(
        string memory name,
        string memory symbol,
        string memory memo,
        string memory cid,
        NFTFeeObject[] memory royalties,  
        int64 maxIssuance  
    ) 
            external
            onlyOwner
            nonReentrant 
        
    returns (address createdTokenAddress, uint maxSupply) {
            require(_token == address(0), "NRst");
            require(bytes(memo).length <= 100, "Memo<100b");
            require(royalties.length <= 10, "<=10Fee");

            _cid = cid;

    // instantiate the list of keys we'll use for token create
    IHederaTokenService.TokenKey[]
            memory keys = new IHederaTokenService.TokenKey[](1);

    keys[0] =  getSingleKey(KeyType.SUPPLY, KeyValueType.CONTRACT_ID, address(this));
    
        // define the token 
        IHederaTokenService.HederaToken memory token;
		token.name = name;
    token.symbol = symbol;
    token.memo = memo;
    token.treasury = address(this);
    token.tokenKeys = keys;
                token.tokenSupplyType = true;
                if (maxIssuance > 0) {
                    // check that there is not already too much metadata in the contract
                    require(_metadata.length <= SafeCast.toUint256(maxIssuance), "TMM");
                    token.maxSupply = maxIssuance ;
                }
                else {
                    require(_metadata.length > 0, "EM");
                token.maxSupply = SafeCast.toInt64(SafeCast.toInt256(_metadata.length)) ;
                }
                _maxSupply = SafeCast.toUint256(token.maxSupply);  

                // translate fee objects to avoid oddites from serialisation of default/empty values
                IHederaTokenService.RoyaltyFee[] memory fees = new IHederaTokenService.RoyaltyFee[](royalties.length);

                for (uint256 f = 0; f < royalties.length; f++) {
                    IHederaTokenService.RoyaltyFee memory fee;
                    fee.numerator = royalties[f].numerator;
                    fee.denominator = royalties[f].denominator;
                    fee.feeCollector = royalties[f].account;

                    if (royalties[f].fallbackfee !=0) {
                        fee.amount = royalties[f].fallbackfee;
                        fee.useHbarsForPayment = true;
                    }

                    fees[f] = fee;
                }

                (int responseCode, address tokenAddress) = HederaTokenService.createNonFungibleTokenWithCustomFees(
                    token,
                    new IHederaTokenService.FixedFee[](0),
                    fees);

    if (responseCode != HederaResponseCodes.SUCCESS) {
        revert ('FM');
    } 
        _token = tokenAddress;
        maxSupply = _maxSupply;

        emit MinterContractMessage("TknCreate", _token, maxSupply);

        createdTokenAddress = _token;

    }

    function mintNFT(uint256 numberToMint) external payable nonReentrant returns (int64[] memory serials, bytes[] memory metadataForMint) {
		require(numberToMint > 0, ">0");
		require(_mintTiming.mintStartTime == 0 ||
			_mintTiming.mintStartTime <= block.timestamp, 
			"NotOpen");
		require(!_mintTiming.mintPaused, "Paused");
		require(numberToMint <= _metadata.length, "MOut");
		require(numberToMint <= _mintEconomics.maxMint, "MaxMint");

		bool isWlMint = false;
		bool found;
		uint numPreviouslyMinted;
		// Design decision: WL max mint per wallet takes priority 
		// over max mint per wallet
		if (_mintTiming.wlOnly) {
			require(MinterLibrary.checkWhitelistConditions(_whitelistedAddressQtyMap, _mintEconomics.maxWlAddressMint), "NotWL");
			// only check the qty if there is a limit at contract level
			if (_mintEconomics.maxWlAddressMint > 0) {
				// we know the address is in the list to get here.
				uint wlMintsRemaining = _whitelistedAddressQtyMap.get(msg.sender);
				require(wlMintsRemaining >= numberToMint, "WLSlots");
				_whitelistedAddressQtyMap.set(msg.sender, wlMintsRemaining -= numberToMint);
			}
			isWlMint = true;
		}
		else if (_mintEconomics.maxMintPerWallet > 0) {
			(found, numPreviouslyMinted) = _addressToNumMintedMap.tryGet(msg.sender);
			if (!found) {
				numPreviouslyMinted = 0;
			}
		
			require((numPreviouslyMinted + numberToMint) <=
					_mintEconomics.maxMintPerWallet,
					">WMax");
		}

		//check if wallet has minted before - if not try and associate
		//SWALLOW ERROR as user may have already associated
		//Ideally we would just check association before the brute force method
		(found, ) = _walletMintTimeMap.tryGet(msg.sender);
		if (!found) {
			//let's associate
			if(IERC721(_token).balanceOf(msg.sender) == 0) associateToken(msg.sender, _token);
			// no need to capture result as failure simply means account already had it associated
			// if user in the mint DB then will not be tried anyway
		}

		//calculate cost
		(uint hbarCost) = getCostInternal(isWlMint);
		uint totalHbarCost = SafeMath.mul(numberToMint, hbarCost);
	
		// take the payment

		if (totalHbarCost > 0) {
			require(msg.value >= totalHbarCost, "+Hbar");
		}

		// pop the metadata
		metadataForMint = new bytes[](numberToMint);
		for (uint m = 0; m < numberToMint; m++) {
			metadataForMint[m] = bytes(string.concat(_cid, _metadata[_metadata.length - 1]));
			// pop discarding the elemnt used up
			_metadata.pop();
		}

		int64[] memory mintedSerials = new int64[](numberToMint);
		for (uint outer = 0; outer < numberToMint; outer += _batchSize) {
			uint batchSize = (numberToMint - outer) >= _batchSize ? _batchSize : (numberToMint - outer);
			bytes[] memory batchMetadataForMint = new bytes[](batchSize);
			for (uint inner = 0; ((outer + inner) < numberToMint) && (inner < _batchSize); inner++) {
				batchMetadataForMint[inner] = metadataForMint[inner + outer];
			}

			(int responseCode, , int64[] memory serialNumbers) 
				= mintToken(_token, 0, batchMetadataForMint);

			if (responseCode != HederaResponseCodes.SUCCESS) {
				revert ("FSMint");
			}

			
			// transfer the token to the user
			address[] memory senderList = new address[](serialNumbers.length);
			address[] memory receiverList = new address[](serialNumbers.length);
			for (uint256 s = 0 ; s < serialNumbers.length; s++) {
				emit MinterContractMessage(string(batchMetadataForMint[s]), msg.sender, SafeCast.toUint256(serialNumbers[s]));
				senderList[s] = address(this);
				receiverList[s] = msg.sender;
				mintedSerials[s + outer] = serialNumbers[s];
				_serialMintTimeMap.set(SafeCast.toUint256(serialNumbers[s]), block.timestamp);
			}

			responseCode = transferNFTs(_token, senderList, receiverList, serialNumbers);

			if (responseCode != HederaResponseCodes.SUCCESS) {
				revert ("FSNFT");
			}
		}
		
		_mintTiming.lastMintTime = block.timestamp;
		_walletMintTimeMap.set(msg.sender, block.timestamp);

		if (isWlMint) {
			(found, numPreviouslyMinted) = _wlAddressToNumMintedMap.tryGet(msg.sender);
			if (found) {
				_wlAddressToNumMintedMap.set(msg.sender, numPreviouslyMinted + numberToMint);
			}
			else {
				_wlAddressToNumMintedMap.set(msg.sender, numberToMint);
			}
		}

		// track all minters in case max mint per wallet required
		(found, numPreviouslyMinted) = _addressToNumMintedMap.tryGet(msg.sender);
		if (found) {
			_addressToNumMintedMap.set(msg.sender, numPreviouslyMinted + numberToMint);
		}
		else {
			_addressToNumMintedMap.set(msg.sender, numberToMint);
		}

		_totalMinted += numberToMint;

		serials = mintedSerials;
		
	}
	// Call to associate a new token to the contract
    // @param tokenId EVM to associate
    function tokenAssociate(address tokenId) internal {
        int256 response = HederaTokenService.associateToken(
            address(this),
            tokenId
        );

        if (response != HederaResponseCodes.SUCCESS) {
            revert("AF");
        }
    }

    // Get the cost for wl addresses
    function getCostInternal(bool wl) internal view returns (uint hbarCost) {
        if (wl) {
            hbarCost = SafeMath.div(
                SafeMath.mul(
                    _mintEconomics.mintPriceHbar,
                    (100 - _mintEconomics.wlDiscount)
                ),
                100
            );
        } else {
            hbarCost = _mintEconomics.mintPriceHbar;
        }
    }

	// function to asses the cost to mint for a user
    // currently flat cost, eventually dynamic on holdings

	function getCost() external view returns (uint hbarCost) {
		(hbarCost) = getCostInternal(
			MinterLibrary.checkWhitelistConditions(
				_whitelistedAddressQtyMap,
				_mintEconomics.maxWlAddressMint
			)
		);
	}

	// Transfer hbar out of the contract
	// function transferHbar(
	// 	address payable receiverAddress,
	// 	uint amount
	// ) external onlyOwner {
	// 	require(
	// 		block.timestamp >= 
	// 			(_mintTiming.lastMintTime + _mintTiming.refundWindow),
	// 		"HbarCdown"
	// 	);
	// 	Address.sendValue(receiverAddress, amount);
	// }

	//Add an address to the allowance WL
	// function addToWhitelist(address[] memory newAddresses) external onlyOwner {
	// 	for (uint a = 0; a < newAddresses.length; a++) {
	// 		bool result = _whitelistedAddressQtyMap.set(
	// 			newAddresses[a],
	// 			_mintEconomics.maxWlAddressMint
	// 		);
	// 		emit MinterContractMessage(
	// 			"ADD WL",
	// 			newAddresses[a],
	// 			result ? 1 : 0
	// 		);
	// 	}
	// }

	// remove address from WL
	// function removeFromWhitelist(
	// 	address[] memory oldAddresses
	// ) external onlyOwner {
	// 	for (uint a = 0; a < oldAddresses.length; a++) {
	// 		bool result = _whitelistedAddressQtyMap.remove(oldAddresses[a]);
	// 		emit MinterContractMessage(
	// 			"REM WL",
	// 			oldAddresses[a],
	// 			result ? 1 : 0
	// 		);
	// 	}
	// }

	// clear the whole WL
	/// Also rerurns numAddressesRemoved how many WL entries were removed
	// function clearWhitelist()
	// 	external
	// 	onlyOwner
	// 	returns (uint numAddressesRemoved)
	// {
	// 	numAddressesRemoved = MinterLibrary.clearWhitelist(
	// 		_whitelistedAddressQtyMap
	// 	);
	// }

	// function to allow the burning oF NFTs
	// function burnNFTs(
	// 	int64[] memory serialNumbers
	// ) external returns (int responseCode, uint64 newTotalSupply) {
	// 	require(serialNumbers.length <= 10, "MaxSerial");
	// 	// need to transfer back to treasury to burn
	// 	address[] memory senderList = new address[](serialNumbers.length);
	// 	address[] memory receiverList = new address[](serialNumbers.length);
	// 	for (uint256 s = 0; s < serialNumbers.length; s++){
	// 		senderList[s] = msg.sender;
	// 		receiverList[s] = address(this);
	// 	}

	// 	responseCode = transferNFTs(
	// 		_token,
	// 		senderList,
	// 		receiverList,
	// 		serialNumbers
	// 	);

	// 	if (responseCode != HederaResponseCodes.SUCCESS) {
	// 		revert("FTNftBrn");
	// 	}

	// 	(responseCode, newTotalSupply) = burnToken(_token, 0, serialNumbers);

	// 	if (responseCode != HederaResponseCodes.SUCCESS) {
	// 		revert("Brn");
	// 	}
	// }

	 // update cost of mint price
	 // @param hbarCost in *tinybar*

	// function updateCost(uint256 hbarCost) external onlyOwner {
	// 	if (_mintEconomics.mintPriceHbar != hbarCost) {
	// 		_mintEconomics.mintPriceHbar = hbarCost;
	// 		emit MinterContractMessage(
	// 			"Hbar MPx",
	// 			msg.sender,
	// 			_mintEconomics.mintPriceHbar
	// 		);
	// 	}
	// }

	// mintPaused boolean to pause (true) or release (false)
	// function updatePauseStatus(
	// 	bool mintPaused
	// ) external onlyOwner returns (bool changed) {
	// 	changed = _mintTiming.mintPaused == mintPaused ? false : true;
	// 	if (changed)
	// 		emit MinterContractMessage(
	// 			mintPaused ? "PAUSED" : "UNPAUSED",
	// 			msg.sender,
	// 			mintPaused ? 1 : 0
	// 		);
	// 	_mintTiming.mintPaused = mintPaused;
	// }

	// lock mint during WL only minting for Wled addresses
	// function updateWlOnlyStatus(
	// 	bool wlOnly
	// ) external onlyOwner returns (bool changed) {
	// 	changed = _mintTiming.wlOnly == wlOnly ? false : true;
	// 	if (changed)
	// 		emit MinterContractMessage(
	// 			wlOnly ? "OnlyWL" : "Open",
	// 			msg.sender,
	// 			wlOnly ? 1 : 0
	// 		);
	// 	_mintTiming.wlOnly = wlOnly;
	// }

	// maxMint int of how many a WL address can mint
	// function setMaxWlAddressMint(
	// 	uint maxMint
	// ) external onlyOwner returns (bool changed) {
	// 	changed = _mintEconomics.maxWlAddressMint == maxMint ? false : true;
	// 	if (changed)
	// 		emit MinterContractMessage("SMaxMint", msg.sender, maxMint);
	// 	_mintEconomics.maxWlAddressMint = maxMint;
	// }

	// startTime new start time in seconds
	function updateMintStartTime(uint256 startTime) external onlyOwner {
		_mintTiming.mintStartTime = startTime;
	}

	// batchSize updated minting batch just in case
	function updateBatchSize(
		uint256 batchSize
	) external onlyOwner returns (bool changed) {
		require((batchSize > 0) && (batchSize <= 10), "Bch Sze");
		changed = _batchSize == batchSize ? false : true;
		_batchSize = batchSize;
	}

	// maxMint new max mint (0 = uncapped)
	function updateMaxMint(uint256 maxMint) external onlyOwner {
		_mintEconomics.maxMint = maxMint;
	}

	// wlDiscount as percentage
	function updateWlDiscount(uint256 wlDiscount) external onlyOwner {
		_mintEconomics.wlDiscount = wlDiscount;
	}

	// cooldownPeriod cooldown period as second
	function updateCooldown(uint256 cooldownPeriod) external onlyOwner {
		_mintTiming.cooldownPeriod = cooldownPeriod;
	}

	// refundWindow refund period in seconds / cap on withdrawals
	function updateRefundWindow(uint256 refundWindow) external onlyOwner {
		_mintTiming.refundWindow = refundWindow;
	}

	// update wlToken
	function updatewlToken(address wlToken) external onlyOwner {
		_mintEconomics.wlToken = wlToken;
	}

	// updateMaxMintPerWallet
	function updateMaxMintPerWallet(uint256 max) external onlyOwner {
		_mintEconomics.maxMintPerWallet = max;
	}

	// cid new cid
	function updateCID(string memory cid) external onlyOwner {
		_cid = cid;
	}

	// metadata new metadata array
	function updateMetadataArray(
		string[] memory metadata,
		uint startIndex
	) external onlyOwner {
		// enforce consistency of the metadata list
		require((startIndex + metadata.length) <= _metadata.length, "offset");
		uint index = 0;
		for (uint i = startIndex; i < (startIndex + metadata.length); i++) {
			_metadata[i] = metadata[index];
			index++;
		}
	}

	// method to push metadata end points up
    function addMetadata(
        string[] memory metadata
    ) external onlyOwner returns (uint totalLoaded) {
        if (_token != address(0)) {
            require(
                (_totalMinted + _metadata.length + metadata.length) <=
                    _maxSupply,
                "tMM"
            );
        }
        for (uint i = 0; i < metadata.length; i++) {
            _metadata.push(metadata[i]);
        }
        totalLoaded = _metadata.length;
    }

	// Helper method to strip storage requirememts
    // boolean toogle to remove the token ID if full reset
    // @param removeToken reset token to zero address
    // @param batch allow for batched reset

    // function resetContract(bool removeToken, uint batch) external onlyOwner {
    //     if (removeToken) {
    //         _token = address(0);
    //         _totalMinted = 0;
    //     }
    //     MinterLibrary.resetContract(
    //         _addressToNumMintedMap,
    //         _metadata,
    //         _walletMintTimeMap,
    //         _wlAddressToNumMintedMap,
    //         _serialMintTimeMap,
    //         _wlSerialsUsed,
    //         batch
    //     );

    //     emit MinterContractMessage(
    //         removeToken ? "ClrTkn" : "RstCtrct",
    //         msg.sender,
    //         0
    //     );
    // }

	// @return metadataList of metadata unminted -> only owner

    // function getMetadataArray(
    //     uint startIndex,
    //     uint endIndex
    // ) external view onlyOwner returns (string[] memory metadataList) {
    //     require(endIndex > startIndex, "args");
    //     require(endIndex <= _metadata.length, "OOR");
    //     metadataList = new string[](endIndex - startIndex);
    //     uint index = 0;
    //     for (uint i = startIndex; i < endIndex; i++) {
    //         metadataList[index] = _metadata[i];
    //         index++;
    //     }
    // }

	// @return token the address for the NFT to be minted
    // function getNFTTokenAddress() external view returns (address token) {
    //     token = _token;
    // }

    // @return numMinted helper function to check how many a wallet has minted
    function getNumberMintedByAddress() external view returns (uint numMinted) {
        bool found;
        uint numPreviouslyMinted;
        (found, numPreviouslyMinted) = _addressToNumMintedMap.tryGet(
            msg.sender
        );
        if (found) {
            numMinted = numPreviouslyMinted;
        } else {
            numMinted = 0;
        }
    }

	// Likely only viable with smaller mints
    // this function will hold the wallet addresses and the number of tokens minted by each wallet, respectively
    // @return walletList list of wallets who minted
    // @return numMintedList lst of number minted

    // function getNumberMintedByAllAddresses()
    //     external
    //     view
    //     onlyOwner
    //     returns (address[] memory walletList, uint[] memory numMintedList)
    // {
    //     walletList = new address[](_addressToNumMintedMap.length());
    //     numMintedList = new uint[](_addressToNumMintedMap.length());
    //     for (uint a = 0; a < _addressToNumMintedMap.length(); a++) {
    //         (walletList[a], numMintedList[a]) = _addressToNumMintedMap.at(a);
    //     }
    // }

	/// @return wlNumMinted helper function to check how many a WLed wallet has minted
    function getNumberMintedBywlAddress()
        external
        view
        returns (uint wlNumMinted)
    {
        bool found;
        uint numPreviouslyMinted;
        (found, numPreviouslyMinted) = _wlAddressToNumMintedMap.tryGet(
            msg.sender
        );
        if (found) {
            wlNumMinted = numPreviouslyMinted;
        } else {
            wlNumMinted = 0;
        }
    }

	// Likely only viable with smaller mints
    /// @return wlWalletList list of wallet who minted
    /// @return wlNumMintedList lst of number minted
    function getNumberMintedByAllWlAddresses()
        external
        view
        onlyOwner
        returns (address[] memory wlWalletList, uint[] memory wlNumMintedList)
    {
        wlWalletList = new address[](_wlAddressToNumMintedMap.length());
        wlNumMintedList = new uint[](_wlAddressToNumMintedMap.length());
        for (uint a = 0; a < _wlAddressToNumMintedMap.length(); a++) {
            (wlWalletList[a], wlNumMintedList[a]) = _wlAddressToNumMintedMap.at(
                a
            );
        }
    }

	//@return getRemaningMint number of NFTs left to mint
    function getRemainingMint() external view returns (uint256 remaningMint) {
        remaningMint = _metadata.length;
    }

    //@return getBatchSize the size for mint/transfer
    function getBatchSize() external view returns (uint batchSize) {
        batchSize = _batchSize;
    }

    // /// check the current Whitelist for minting
    // /// @return wl an array of addresses currently enabled for allowance approval
    // function getWhitelist()
    //     external
    //     view
    //     returns (address[] memory wl, uint[] memory wlQty)
    // {
    //     wl = new address[](_whitelistedAddressQtyMap.length());
    //     wlQty = new uint[](_whitelistedAddressQtyMap.length());

    //     for (uint a = 0; a < _whitelistedAddressQtyMap.length(); a++) {
    //         (wl[a], wlQty[a]) = _whitelistedAddressQtyMap.at(a);
    //     }
    // }

	/// @return mintEconomics basic struct with mint economics details
    function getMintEconomics()
        external
        view
        returns (MintEconomics memory mintEconomics)
    {
        mintEconomics = _mintEconomics;
    }

    /// @return mintTiming basic struct with mint economics details
    function getMintTiming()
        external
        view
        returns (MintTiming memory mintTiming)
    {
        mintTiming = _mintTiming;
    }

    // // check if the address is in wl
    // // @param addressToCheck the address to check in WL
    // // @return inwl if in the WL
    // // @return qty the number of WL mints (0 = unbounded)
    // function isAddressWL(
    //     address addressToCheck
    // ) external view returns (bool inWl, uint qty) {
    //     (inWl, qty) = _whitelistedAddressQtyMap.tryGet(addressToCheck);
    // }


    receive() external payable {
 
    }

    fallback() external payable {
  
    }
}   
