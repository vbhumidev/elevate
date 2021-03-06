﻿/*
 * Copyright 2016-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

/* jshint node: true, devel: true */
'use strict';

const crypto = require('crypto'),
    request = require('request'),
    orders = require('../lib/robinhood/orders.js'),
    place_buy_order = require('../lib/robinhood/place_buy_order.js'),
    place_sell_order = require('../lib/robinhood/place_sell_order.js'),
    Score = require('./news.js'),
    pug = require('pug');
const user = require('../models/user.model');

module.exports = class MessengerController {
    constructor(app) {
        // App Secret can be retrieved from the App Dashboard
        this.APP_SECRET = process.env.MESSENGER_APP_SECRET;

        // Arbitrary value used to validate a webhook
        this.VALIDATION_TOKEN = process.env.MESSENGER_VALIDATION_TOKEN;

        // Generate a page access token for your page from the App Dashboard
        this.PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;

        // URL where the app is running (include protocol). Used to point to scripts and
        // assets located at this address.
        this.SERVER_URL = process.env.SERVER_URL;

        /*
         * Use your own validation token. Check that the token used in the Webhook
         * setup is the same token used here.
         *
         */
        app.get('/webhook', (req, res) => {
            if (req.query['hub.mode'] === 'subscribe' &&
                req.query['hub.verify_token'] === this.VALIDATION_TOKEN) {
                console.log("Validating webhook");
                res.status(200).send(req.query['hub.challenge']);
            } else {
                console.error("Failed validation. Make sure the validation tokens match.");
                res.sendStatus(403);
            }
        });


        /*
         * All callbacks for Messenger are POST-ed. They will be sent to the same
         * webhook. Be sure to subscribe your app to your page to receive callbacks
         * for your page.
         * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
         *
         */
        app.post('/webhook', (req, res) => {
            var data = req.body;

            // Make sure this is a page subscription
            if (data.object === 'page') {
                // Iterate over each entry
                // There may be multiple if batched
                data.entry.forEach((pageEntry) => {
                        var pageID = pageEntry.id;
                        var timeOfEvent = pageEntry.time;

                        // Iterate over each messaging event
                        pageEntry.messaging.forEach((messagingEvent) => {
                                if (messagingEvent.optin) {
                                    this.receivedAuthentication(messagingEvent);
                                } else if (messagingEvent.message) {
                                    this.receivedMessage(messagingEvent);
                                } else if (messagingEvent.delivery) {
                                    this.receivedDeliveryConfirmation(messagingEvent);
                                } else if (messagingEvent.postback) {
                                    this.receivedPostback(messagingEvent);
                                } else if (messagingEvent.read) {
                                    this.receivedMessageRead(messagingEvent);
                                } else if (messagingEvent.account_linking) {
                                    this.receivedAccountLink(messagingEvent);
                                } else {
                                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                                }
                            }
                        );
                    }
                );

                // Assume all went well.
                //
                // You must send back a 200, within 20 seconds, to let us know you've
                // successfully received the callback. Otherwise, the request will time out.
                res.sendStatus(200);
            }
        });

        /*
         * This path is used for account linking. The account linking call-to-action
         * (sendAccountLinking) is pointed to this URL.
         *
         */
        app.get('/authorize', (req, res) => {
            // var accountLinkingToken = req.query.account_linking_token;
            // var redirectURI = req.query.redirect_uri;
            //
            // // Authorization Code should be generated per user by the developer. This will
            // // be passed to the Account Linking callback.
            // var authCode = "1234567890";
            //
            // // Redirect users to this URI on successful login
            // var redirectURISuccess = redirectURI + "&authorization_code=" + authCode;
            var html = pug.renderFile('./views/authorize.pug', {
                pageTitle: 'Link Robinhood Account',
                userID: req.query.userID
            });
            res.end(html);
        });

        app.post('/robinhood/signin', (req, res) => {
            var data = '';
            req.on('data', (chunk) => {
                data += chunk;
            });

            req.on('end', () => {
                const body = querystring.parse(data);

                this.signIn(body.userID, body.username, body.password)
                    .then(() => {
                            const userID = body.userID;
                            res.send();
                        },
                        () => {
                            const html = pug.renderFile('./views/authorize.pug', {
                                pageTitle: 'Fail to Log in',
                                error: 'Your Robinhood username or password was entered incorrectly',
                                userID: req.query.userID
                            });
                            res.end(html);
                        });
                res.end();
            });
        });
    }

    signIn(userId, username, password) {
        return new Promise((success, fail) => {
            const credentials = {
                username: username,
                password: password
            };
            const Robinhood = require('robinhood')(credentials, function (err) {
                if (err) {
                    return fail(err);
                }
                user.findOneAndUpdate(
                    {facebook_profile_id: userId}, {
                        robinhood_username: username,
                        robinhood_password: password
                    }, (err) => {
                        if (err) {
                            return fail(err);
                        }
                        return success();
                    }
                );
            });
        });
    }

    /*
     * Verify that the callback came from Facebook. Using the App Secret from
     * the App Dashboard, we can verify the signature that is sent with each
     * callback in the x-hub-signature field, located in the header.
     *
     * https://developers.facebook.com/docs/graph-api/webhooks#setup
     *
     */
    verifyRequestSignature(req, res, buf) {
        var signature = req.headers["x-hub-signature"];

        if (!signature) {
            // For testing, let's log an error. In production, you should throw an
            // error.
            console.error("Couldn't validate the signature.");
        } else {
            var elements = signature.split('=');
            var method = elements[0];
            var signatureHash = elements[1];

            var expectedHash = crypto.createHmac('sha1', this.APP_SECRET)
                .update(buf)
                .digest('hex');

            if (signatureHash !== expectedHash) {
                throw new Error("Couldn't validate the request signature.");
            }
        }
    }

    /*
     * Authorization Event
     *
     * The value for 'optin.ref' is defined in the entry point. For the "Send to
     * Messenger" plugin, it is the 'data-ref' field. Read more at
     * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
     *
     */
    receivedAuthentication(event) {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;
        var timeOfAuth = event.timestamp;

        // The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
        // The developer can set this to an arbitrary value to associate the
        // authentication callback with the 'Send to Messenger' click event. This is
        // a way to do account linking when the user clicks the 'Send to Messenger'
        // plugin.
        var passThroughParam = event.optin.ref;

        console.log("Received authentication for user %d and page %d with pass " +
            "through param '%s' at %d", senderID, recipientID, passThroughParam,
            timeOfAuth);

        // When an authentication is received, we'll send a message back to the sender
        // to let them know it was successful.
        this.sendTextMessage(senderID, "Authentication successful");
    }

    findUser(facebookUserID) {
        return new Promise((resolve, reject) => {
            user.findOne({facebook_profile_id: facebookUserID}, (err, data) => {
                if (err) {
                    return reject(err);
                }
                return resolve();

            });

        });
        console.log(facebookUserID);
        return null;
    }

    promoteAccountLinking(facebookUserID) {
        this.sendButtonMessage(
            facebookUserID,
            'Link to your Robinhood account and start trading',
            [
                {
                    type: 'account_link',
                    url: `${this.SERVER_URL}authorize?userID=${facebookUserID}`
                }
            ]
        );
    }

    /*
     * Message Event
     *
     * This event is called when a message is sent to your page. The 'message'
     * object format can vary depending on the kind of message that was received.
     * Read more at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
     *
     * For this example, we're going to echo any text that we get. If we get some
     * special keywords ('button', 'generic', 'receipt'), then we'll send back
     * examples of those bubbles to illustrate the special message bubbles we've
     * created. If we receive a message with an attachment (image, video, audio),
     * then we'll simply confirm that we've received the attachment.
     *
     */
    receivedMessage(event) {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;
        var timeOfMessage = event.timestamp;
        var message = event.message;

        if (!message.text) {
            this.sendTextMessage(senderID, `Ha?`);
            return;
        }

        console.log("Received message for user %d and page %d at %d with message:",
            senderID, recipientID, timeOfMessage);

        // var isEcho = message.is_echo;
        var messageId = message.mid;
        var appId = message.app_id;
        var metadata = message.metadata;

        // You may get a text or attachment but not both
        var messageText = message.text;
        var messageAttachments = message.attachments;

        const handlers = [
            {
                getUser: () => this.findUser(senderID),
                // buy 100 Apple
                command: /^buy ([0-9]+) ([0-9a-zA-Z ]+)$/i,
                action: (numOfShares, stockName) => {
                    this.sendTextMessage(senderID, `Bought ${numOfShares} shares of ${stockName}`);
                }
            },
            {
                getUser: () => this.findUser(senderID),
                // buy $100 Apple  user_id, symbol, quantity, price
                command: /^buy \$([0-9]+) ([0-9a-zA-Z ]+)$/i,
                action: (dollars, stockName) => {
                    place_buy_order(senderID, stockName, numOfShares);
                    this.sendTextMessage(senderID, `Bought 20 shares of ${stockName} worth $${dollars}`);
                }
            },
            {
                getUser: () => this.findUser(senderID),
                // sell 100 Apple
                command: /^sell ([0-9]+) ([0-9a-zA-Z ]+)$/i,
                action: (numOfShares, stockName) => {
                    place_sell_order(senderID, stockName, numOfShares);
                    this.sendTextMessage(senderID, `Sold ${numOfShares} shares of ${stockName}`);
                }
            },
            {
                getUser: () => this.findUser(senderID),
                // buy $100 Apple
                command: /^sell \$([0-9]+) ([0-9a-zA-Z ]+)$/i,
                action: (dollars, stockName) => {
                    this.sendTextMessage(senderID, `Sold 20 shares of ${stockName} worth $${dollars}`);
                }
            },
            {
                getUser: () => this.findUser(senderID),
                // list
                command: /^list$/i,
                action: () => {
                    orders(senderID);
                    this.sendTextMessage(senderID, `List all orders`);
                }
            },
            {
                getUser: () => this.findUser(senderID),
                // cancel
                command: /^cancel$/i,
                action: () => {
                    this.sendTextMessage(senderID, `100 units Apple purchase order is canceled`);
                }
            },
            {
                //show list of example stock codes
                command: /^stocks$/i,
                action: () => {
                    const stockNames = [
                        {
                            name: 'Apple Inc',
                            code: 'APPL'
                        },
                        {
                            name: 'Microsoft Corp',
                            code: 'MSFT'
                        },
                        {
                            name: 'Facebook Inc',
                            code: 'FB'
                        },
                        {
                            name: 'International Business Machines',
                            code: 'IBM'
                        },
                        {
                            name: 'Alphabet Class C',
                            code: 'GOOGL'
                        },
                        {
                            name: 'Salesforce.Com Inc',
                            code: 'CRM'
                        }
                    ];

                    const message = stockNames.map(stock => `${stock.code}\n${stock.name}`)
                        .join('\n\n');
                    this.sendTextMessage(senderID, message);
                }
            },
            {
                //get stock price
                command: /^price of ([0-9a-zA-Z ]+)$/i,
                action: (stockName) => {
                    var Robinhood = require('robinhood')({token: ''}, () => {
                        Robinhood.quote_data(stockName.toUpperCase(), (error, response, body) => {
                            if (error) this.sendTextMessage(senderID, `I am not able to find the stock price for ${stockName}`);
                            const price = body.results[0].ask_price;
                            this.sendTextMessage(senderID, `${stockName} is at $${price}`);
                        });

                    });
                }
            },
            {
                //get stock price
                command: /^help$/i,
                action: () => {
                    const commands = [
                        {
                            cmd: 'buy 100 APPL',
                            message: 'Buy 100 units Apple stock'
                        },
                        {
                            cmd: 'buy $100 APPL',
                            message: 'Buy Apple stocks worth 100 dollars'
                        },
                        {
                            cmd: 'sell 100 APPL',
                            message: 'Sell 100 units Apple stock'
                        },
                        {
                            cmd: 'sell $100 APPL',
                            message: 'Sell Apple stocks worth 100 dollars'
                        },
                        {
                            cmd: 'list',
                            message: 'List all the orders placed'
                        },
                        {
                            cmd: 'stocks',
                            message: 'List stock code for popular tech companies'
                        },
                        {
                            cmd: 'price of APPL',
                            message: 'Get the current stock price for Apple'
                        },
                        {
                            cmd: 'news of APPL',
                            message: 'Show news and the probability of making profit for given stock'
                        },
                        {
                            cmd: 'vis APPL',
                            message: 'Visualize the change of profits and investments'
                        },
                        {
                            cmd: 'cancel',
                            message: 'Cancel the last order'
                        }
                    ];
                    const helpMessage = commands.map(command =>
                        `${command.cmd} => ${command.message}`)
                        .join('\n\n');
                    this.sendTextMessage(senderID, helpMessage);
                }
            },
            {
                //get news
                command: /^news of ([0-9a-zA-Z ]+)$/i,
                action: (stockName) => {
                    const news = new Score(stockName);
                    news.exe((answer, score) => {
                        if (!answer) {
                            this.sendTextMessage(senderId, `Sorry, we are not able to find news about ${stockName} for the past week.`);
                        }else {
                            var addition = "";
                            if (score < 0.3) {
                                addition = ` ${stockName} has received a lot of negative media coverage. It might affect the stock price negatively.`;
                            } else if (score > 0.7) {
                                addition = `. ${stockName} has been showing up positively in media. Good for you!`;
                            }
                            
                            this.sendTextMessage(senderID, `The most recent news headlines for ${stockName} is ${answer[0]}`);
                            this.sendTextMessage(senderID, `The average positivity score for news in the past week is ${score}` + addition);
                        }
                    });
                }
            },
            {
                command: /^vis/i,
                action: () => {
                    this.sendImageMessage(senderID)
                }

            }
        ];

        for (let handler of handlers) {
            let results= messageText.match(handler.command);
            if (results) {
                let params = results.slice(1);
                if (handler.getUser) {
                    handler.getUser().catch((err) => {
                        return this.promoteAccountLinking(senderID);
                    }).then((user) => {
                        params.append(user);
                        handler.action.apply(this, params);
                    });

                } else {
                    handler.action.apply(this, params);
                }
                return;
            }
        }
        this.sendTextMessage(senderID, `I haven't supported '${messageText}' yet. Please reply 'help' to check all the commands available.`);
    }


    /*
     * Delivery Confirmation Event
     *
     * This event is sent to confirm the delivery of a message. Read more about
     * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
     *
     */
    receivedDeliveryConfirmation(event) {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;
        var delivery = event.delivery;
        var messageIDs = delivery.mids;
        var watermark = delivery.watermark;
        var sequenceNumber = delivery.seq;

        if (messageIDs) {
            messageIDs.forEach((messageID) => {
                    console.log("Received delivery confirmation for message ID: %s",
                        messageID);
                }
            );
        }

        console.log("All message before %d were delivered.", watermark);
    }


    /*
     * Postback Event
     *
     * This event is called when a postback is tapped on a Structured Message.
     * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
     *
     */
    receivedPostback(event) {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;
        var timeOfPostback = event.timestamp;

        // The 'payload' param is a developer-defined field which is set in a postback
        // button for Structured Messages.
        var payload = event.postback.payload;

        console.log("Received postback for user %d and page %d with payload '%s' " +
            "at %d", senderID, recipientID, payload, timeOfPostback);

        // When a postback is called, we'll send a message back to the sender to
        // let them know it was successful
        this.sendTextMessage(senderID, "Postback called");
    }

    /*
     * Message Read Event
     *
     * This event is called when a previously-sent message has been read.
     * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
     *
     */
    receivedMessageRead(event) {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;

        // All messages before watermark (a timestamp) or sequence have been seen.
        var watermark = event.read.watermark;
        var sequenceNumber = event.read.seq;

        console.log("Received message read event for watermark %d and sequence " +
            "number %d", watermark, sequenceNumber);
    }

    /*
     * Account Link Event
     *
     * This event is called when the Link Account or UnLink Account action has been
     * tapped.
     * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
     *
     */
    receivedAccountLink(event) {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;

        var status = event.account_linking.status;
        var authCode = event.account_linking.authorization_code;

        console.log("Received account link event with for user %d with status %s " +
            "and auth code %s ", senderID, status, authCode);
    }

    /*
     * Send an image using the Send API.
     *
     */
    sendImageMessage(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "image",
                    payload: {
                        url: this.SERVER_URL + "/image.png"
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a Gif using the Send API.
     *
     */
    sendGifMessage(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "image",
                    payload: {
                        url: this.SERVER_URL + "/assets/instagram_logo.gif"
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send audio using the Send API.
     *
     */
    sendAudioMessage(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "audio",
                    payload: {
                        url: this.SERVER_URL + "/assets/sample.mp3"
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a video using the Send API.
     *
     */
    sendVideoMessage(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "video",
                    payload: {
                        url: this.SERVER_URL + "/assets/allofus480.mov"
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a file using the Send API.
     *
     */
    sendFileMessage(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "file",
                    payload: {
                        url: this.SERVER_URL + "/assets/test.txt"
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a text message using the Send API.
     *
     */
    sendTextMessage(recipientId, messageText) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                text: messageText,
                metadata: "DEVELOPER_DEFINED_METADATA"
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a button message using the Send API.
     *
     */
    sendButtonMessage(recipientId, text, buttons) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        text: text,
                        template_type: "button",
                        buttons: buttons
                    }
                }
            }
        };
        this.callSendAPI(messageData);
    }

    /*
     * Send a Structured Message (Generic Message type) using the Send API.
     *
     */
    sendGenericMessage(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        elements: [{
                            title: "rift",
                            subtitle: "Next-generation virtual reality",
                            item_url: "https://www.oculus.com/en-us/rift/",
                            image_url: this.SERVER_URL + "/assets/rift.png",
                            buttons: [{
                                type: "web_url",
                                url: "https://www.oculus.com/en-us/rift/",
                                title: "Open Web URL"
                            }, {
                                type: "postback",
                                title: "Call Postback",
                                payload: "Payload for first bubble",
                            }],
                        }, {
                            title: "touch",
                            subtitle: "Your Hands, Now in VR",
                            item_url: "https://www.oculus.com/en-us/touch/",
                            image_url: this.SERVER_URL + "/assets/touch.png",
                            buttons: [{
                                type: "web_url",
                                url: "https://www.oculus.com/en-us/touch/",
                                title: "Open Web URL"
                            }, {
                                type: "postback",
                                title: "Call Postback",
                                payload: "Payload for second bubble",
                            }]
                        }]
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a receipt message using the Send API.
     *
     */
    sendReceiptMessage(recipientId) {
        // Generate a random receipt ID as the API requires a unique ID
        var receiptId = "order" + Math.floor(Math.random() * 1000);

        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "receipt",
                        recipient_name: "Peter Chang",
                        order_number: receiptId,
                        currency: "USD",
                        payment_method: "Visa 1234",
                        timestamp: "1428444852",
                        elements: [{
                            title: "Oculus Rift",
                            subtitle: "Includes: headset, sensor, remote",
                            quantity: 1,
                            price: 599.00,
                            currency: "USD",
                            image_url: this.SERVER_URL + "/assets/riftsq.png"
                        }, {
                            title: "Samsung Gear VR",
                            subtitle: "Frost White",
                            quantity: 1,
                            price: 99.99,
                            currency: "USD",
                            image_url: this.SERVER_URL + "/assets/gearvrsq.png"
                        }],
                        address: {
                            street_1: "1 Hacker Way",
                            street_2: "",
                            city: "Menlo Park",
                            postal_code: "94025",
                            state: "CA",
                            country: "US"
                        },
                        summary: {
                            subtotal: 698.99,
                            shipping_cost: 20.00,
                            total_tax: 57.67,
                            total_cost: 626.66
                        },
                        adjustments: [{
                            name: "New Customer Discount",
                            amount: -50
                        }, {
                            name: "$100 Off Coupon",
                            amount: -100
                        }]
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a message with Quick Reply buttons.
     *
     */
    sendQuickReply(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                text: "What's your favorite movie genre?",
                quick_replies: [
                    {
                        "content_type": "text",
                        "title": "Action",
                        "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_ACTION"
                    },
                    {
                        "content_type": "text",
                        "title": "Comedy",
                        "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_COMEDY"
                    },
                    {
                        "content_type": "text",
                        "title": "Drama",
                        "payload": "DEVELOPER_DEFINED_PAYLOAD_FOR_PICKING_DRAMA"
                    }
                ]
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a read receipt to indicate the message has been read
     *
     */
    sendReadReceipt(recipientId) {
        console.log("Sending a read receipt to mark message as seen");

        var messageData = {
            recipient: {
                id: recipientId
            },
            sender_action: "mark_seen"
        };

        this.callSendAPI(messageData);
    }

    /*
     * Turn typing indicator on
     *
     */
    sendTypingOn(recipientId) {
        console.log("Turning typing indicator on");

        var messageData = {
            recipient: {
                id: recipientId
            },
            sender_action: "typing_on"
        };

        this.callSendAPI(messageData);
    }

    /*
     * Turn typing indicator off
     *
     */

    sendTypingOff(recipientId) {
        console.log("Turning typing indicator off");

        var messageData = {
            recipient: {
                id: recipientId
            },
            sender_action: "typing_off"
        };

        this.callSendAPI(messageData);
    }

    /*
     * Send a message with the account linking call-to-action
     *
     */
    sendAccountLinking(recipientId) {
        var messageData = {
            recipient: {
                id: recipientId
            },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "button",
                        text: "Welcome. Link your account.",
                        buttons: [{
                            type: "account_link",
                            url: this.SERVER_URL + "/authorize"
                        }]
                    }
                }
            }
        };

        this.callSendAPI(messageData);
    }

    /*
     * Call the Send API. The message data goes in the body. If successful, we'll
     * get the message id in a response
     *
     */
    callSendAPI(messageData) {
        request({
            uri: 'https://graph.facebook.com/v2.6/me/messages',
            qs: {access_token: this.PAGE_ACCESS_TOKEN},
            method: 'POST',
            json: messageData

        }, (error, response, body) => {
            if (!error && response.statusCode === 200) {
                var recipientId = body.recipient_id;
                var messageId = body.message_id;

                if (messageId) {
                    console.log("Successfully sent message with id %s to recipient %s",
                        messageId, recipientId);
                } else {
                    console.log("Successfully called Send API for recipient %s",
                        recipientId);
                }
            } else {
                console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
            }
        });
    }
};
