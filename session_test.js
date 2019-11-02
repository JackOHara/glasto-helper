#!/usr/bin/env node

const winston = require('winston');
const argv = require('yargs').argv
const readline = require('readline');
const fs = require('fs');
const util = require('util');
const puppeteer = require("puppeteer-extra")
const pluginStealth = require("puppeteer-extra-plugin-stealth")
puppeteer.use(pluginStealth())
const readFile = util.promisify(fs.readFile);
process.setMaxListeners(Infinity);

//TODO: Seperate logger into own file
const logger = winston.createLogger({
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
        winston.format.printf((info) => {
            return JSON.stringify({
                timestamp: info.timestamp,
                level: info.level,
                tab: info.tab,
                message: info.message
            });
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: 'glasto.log'
        })
    ]
})


/*
Excuse my node

To-do
High priority:

Low priority:
    - Extract inner text from actual glastonbury page using same method so we can match better. The 2019 glasto page exists on the selenium page. 
    - Add randomness to refresh time
Other:
    - It would be nice to scale this so it's not just maxing out one device. How though? Possibly containerize and give each container its own VPN
*/

class Tabs {
    constructor(url, rateLimitPerMinute, registrationPageInnerText) {
        this.tabs = [];
        this.url = url;
        this.refreshRateInMs = (60 / rateLimitPerMinute) * 1000;
        this.registrationPageInnerText = registrationPageInnerText;
        this.paused = false;
        this.similarityThreshold = 80;
        this.lastHighScorer = -1;
    }

    setPaused(paused) {
        if (paused) {
            logger.info("Pausing operation. Tabs wills finish their current page load.");
        } else {
            logger.info("Resuming operation.");
        }
        this.paused = paused;
    }

    getPaused() {
        return this.paused;
    }

    async initializeTabs(tabQuantity) {
        this.tabs = [];
        for (let i = 0; i < tabQuantity; i++) {
            let tab = new Tab(this.url);
            await tab.initialiseTab();
            this.tabs.push(tab);
        }
    }

    async restartTab(tabIndex) {
        await this.tabs[tabIndex].close();
        let tab = new Tab(this.url);
        this.tabs[tabIndex] = tab;
        await this.tabs[tabIndex].initialiseTab();
    }

    async closeTabs() {
        for (let i = 0; i < this.tabs.length; i++) {
            await this.tabs[i].close();
        }
    }

    calculateSimilarity(retrievedText, desiredText) {
        const retrievedTextTokens = retrievedText.replace(/(\r\n|\n|\r)/gm, "").toLowerCase().split(" ");
        const desiredTextTokens = desiredText.replace(/(\r\n|\n|\r)/gm, "").toLowerCase().split(" ");
        let countOfMatchingWords = 0;

        // How could this be improved?
        for (let i = 0; i < desiredTextTokens.length; i++) {
            if (retrievedTextTokens.includes(desiredTextTokens[i])) {
                countOfMatchingWords = countOfMatchingWords + 1;
            }
        }

        const score = (countOfMatchingWords / desiredTextTokens.length) * 100;
        return score;
    }

    async getHighestScoringTabIndex() {
        // Get the tab with highest score. Return the first found if multiple exist with same score
        let highestScorer = null;
        for (let i = 0; i < this.tabs.length; i++) {
            if (highestScorer == null) {
                highestScorer = i;
                continue;
            }
            if (await this.tabs[i].getSimilarityScore() > await this.tabs[highestScorer].getSimilarityScore()) {
                highestScorer = i;
            }
        }
        return highestScorer;
    }

    // TODO: tidy method
    async loadPagesAtRate() {
        while (true) {
            for (let i = 0; i < this.tabs.length; i++) {
                while (this.paused == true) {
                    await this.sleep(10);
                }
                //Don't reload the page we think is most similar, unless it's score is 0 (which it starts off with)
                if (i != await this.getHighestScoringTabIndex() || await this.tabs[i].getSimilarityScore() == -1) {
                    if (await this.tabs[i].getReady() == true) {

                        logger.info({
                            tab: i,
                            message: `Loading page`
                        });
                        this.tabs[i].loadPage().then(async page => {
                            logger.info({
                                tab: i,
                                message: `Loaded page in ${Date.now() - this.tabs[i].getStartTime()}ms`
                            });

                            await this.tabs[i].getInnerHtmlTextOfAllElements().then(async pageInnerHtmlText => {
                                const similarityScore = await this.calculateSimilarity(pageInnerHtmlText, this.registrationPageInnerText);
                                await this.tabs[i].setSimilarityScore(similarityScore);
                                logger.info({
                                    tab: i,
                                    message: `${similarityScore.toFixed(2)}% similarity found`
                                });

                                //Hard coded this pause as results from the coach tickets run showed the page we want has a similarity score of 91
                                if (similarityScore > this.similarityThreshold) {
                                    this.paused = true;
                                    logger.info({
                                        tab: i,
                                        message: `Paused operation as page with > ${this.similarityThreshold}% found`
                                    });
       
                                    const successfulBrowser = await this.tabs[i].getBrowser()
                                    const successfulBrowserPages = await successfulBrowser.pages()
                                    const successfulBrowserPage = successfulBrowserPages.pop()
                                    const successfulBrowserCookies = await successfulBrowserPage.cookies()
                                    const successfulBrowserPageUrl = await successfulBrowserPage.url();
                                    const newBrowser = await puppeteer.launch({
                                        headless: false
                                    });
                                    
                                    const pages = await newBrowser.pages();
                                    const page = pages.pop();
                                    await page.setCookie(successfulBrowserCookies.pop())
                                    await page.goto(successfulBrowserPageUrl, {
                                        waitUntil: 'networkidle2',
                                        timeout: 30000
                                    });

                                    //create new browser


                                }
                                const highestScoringTab = await this.getHighestScoringTabIndex();
                                if(highestScoringTab != this.lastHighScorer) {
                                    this.lastHighScorer = highestScoringTab;
                                    await this.tabs[highestScoringTab].bringToFront();
                                }
                                await this.tabs[i].setReady(true);
                            });
                        }).catch(async error => {
                            logger.error({
                                tab: i,
                                message: error.toString()
                            });
                            await this.tabs[i].setReady(true);
                        });

                        //Wait until enough time has passed before loading next tab so we don't break the rate limit
                        const finishTime = Date.now();
                        if (finishTime - this.tabs[i].getStartTime() < this.refreshRateInMs) {
                            await this.sleep(this.refreshRateInMs - (finishTime - this.tabs[i].getStartTime()));
                        }
                    } else {
                        // I've added a sleep here as when there are no pages ready it will freeze up
                        await this.sleep(10);
                    }
                }
            }
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

class Tab {
    constructor(url) {
        this.url = url;
        this.page = null;
        this.browser = null;
        this.innerHtmlText = null;
        this.similarityScore = -1;
        this.ready = false;
        this.startTime = null;
    }

    async getBrowser() {
        return await this.browser
    }
    getReady() {
        return this.ready;
    }

    setReady(ready) {
        this.ready = ready;
    }
    getSimilarityScore() {
        return this.similarityScore;
    }
    getStartTime() {
        return this.startTime;

    }
    setSimilarityScore(similarityScore) {
        this.similarityScore = similarityScore;
    }

    async bringToFront() {
        this.page.bringToFront();
    }

    async initialiseTab() {
        logger.info("Spawning new tab")
        this.browser = await puppeteer.launch({
            headless: true
        });
        const pages = await this.browser.pages();

        this.page = pages.pop();
        this.ready = true;
    }

    async close() {
        await this.browser.close()
        return await this.page.close();
    }

    async loadPage() {
        this.startTime = Date.now();
        await this.setReady(false);
        return await this.page.goto(this.url, {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
    }

    async getInnerHtmlTextOfAllElements() {
        let innerHtmlTextOfAllElements = "";
        const options = await this.page.$$('body *');
        for (const option of options) {

            const label = await this.page.evaluate(el => el.innerText, option);
            if (label != undefined && label.length > 0) {
                innerHtmlTextOfAllElements = innerHtmlTextOfAllElements + label.trim() + " ";
            }
        }
        return innerHtmlTextOfAllElements;
    }

    async evaluateSelector(selector) {
        const result = await this.page.evaluate(selector);
        return result || '';
    }

}

function parseArgs() {
    if (!(argv['site'] && argv['rate-limit'] && argv['max-tabs'])) {
        log.info(`Usage:\nnode main.js --site=\"localhost:3000\" --rate-limit=60 --max-tabs=10`);
        process.exit(0);
    }
    return argv;
}

async function readFileAsString(filePath) {
    return await readFile(filePath);
}

async function getRegistrationPageInnerText() {
    if (argv['test'] && argv['test'] !== 'false') {
        return await readFileAsString("resources/test.txt").then(data => {
            return data.toString();
        });
    } else {
        return await readFileAsString("resources/live.txt").then(data => {
            return data.toString();
        });
    }
}

async function run() {
    parseArgs();
    const registrationPageInnerText = await getRegistrationPageInnerText();

    const tabs = new Tabs(argv['site'], argv['rate-limit'], registrationPageInnerText);

    // Pause/resume by pressing enter
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (str, key) => {
        if (key.ctrl && key.name === 'c') {
            tabs.closeTabs();
            process.exit(0);
        } else if (key.name == 'enter') {
            tabs.setPaused(!tabs.getPaused());
        }
    });

    await tabs.initializeTabs(argv['max-tabs']);
    await tabs.loadPagesAtRate();
}
run();