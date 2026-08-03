------------------------------------------------------------------------

# DOM Tweet Scraper

A free browser userscript that collects tweets from an X (Twitter) profile by reading the page's DOM as you scroll — wtihout an API key. It runs entirely in your own browser, using your own logged-in session, and saves what it finds to a CSV file on your computer.

Built with [Tampermonkey](https://www.tampermonkey.net/) in mind, but should work with any userscript manager (Violentmonkey, Greasemonkey, etc.).

## What it does

- Auto-scrolls a profile's timeline at a human-like, randomized pace
- Extracts each tweet's date, author, type (original / quote / repost), and full text — including expanding "Show more" truncated tweets.
- Stores results locally in your browser (`localStorage`) so you can stop and resume without losing progress.
- Lets you export a single account's tweets, or everything you've collected across accounts, to a `csv` file.
- Has a small on-page control panel with a live preview of the last few tweets captured, so you can sanity-check it's reading things correctly.

## Installation

1.  Install a userscript manager, e.g. [Tampermonkey](https://www.tampermonkey.net/) (Chrome, Firefox, Edge, Safari all supported). See Tampermonkey's set up tutorial for more information. The extension must be on Developer mode.
2.  Open Tampermonkey's dashboard → **Create a new script**.
3.  Delete the placeholder content and paste in the full contents of [`tweet-collector.user.js`](./tweet-collector.user.js) from this repo.
4.  Save (Cmd+S / Ctrl+S). Make sure the script is enabled.

## Usage

1.  Go to the Twitter profile you want to collect (their main profile page, Posts tab works best).
2.  A small "Tweet Collector" panel will appear in the bottom-right corner of the page.
3.  Optionally set:
    - **Max scrolls** — how many scroll steps to run before stopping.
    - **Pause (ms)** — base delay between scrolls.
    - **Stop at date** — stop once it reaches tweets older than a given date.
      - While no issues of posts falling through the cracks have been recorded, letting the scraper run for the full length of the page has the added benefit of offering a cross-reference to number of tweets collected versus number of tweets posted by one account.
4.  Click **Start collecting**. Watch the live preview to confirm it's grabbing tweet text correctly.
5.  Click **Stop** any time, or let it stop on its own (hits max scrolls, hits your date cutoff, or runs out of new content).
6.  Use **Export this account CSV** or **Export ALL accounts CSV** to download your results.

Collected data persists in your browser's local storage between sessions, so you can pick up scrolling later without losing what you've already gathered. Use **Wipe all data** to clear everything and start fresh.

## Important: a note on Terms of Service

This tool automates scrolling and reading of publicly rendered page content in your own browser session. Automated collection of data from Twitter, including via browser automation or scripting like this, is very likely to conflict with **X's Terms of Service**, which restrict scraping and automated data collection regardless of whether an official API is used.

This project is shared for educational and research purposes (e.g. personal archiving, journalism, academic research on publicly available posts). Using it is **your own decision and your own responsibility** — running this script does not make the activity compliant with X's terms, and this README does not change that. If you plan to use collected data publicly, commercially, or at scale, you may want to review X's Terms of Service and consider consulting someone knowledgeable about the relevant terms and any applicable laws in your jurisdiction (e.g. data protection or computer-use regulations) before proceeding.

*Using a burner account is strongly recommended.*

## Technical specs & Limitations

This is V1 of the project. Updates will be provided sporadically.

- The scraper was built to run on MacOS, using [Brave](https://brave.com/). There is no reason why this should break on other operating systems or browsers, but it has not been tested.
- There is some stochasticity to the pause and the scroll length function, currently set at 35% -- this seems to help dupe the human verifier.
- A nice bonus of running it locally is that you get access to Groks translation feature. Some tweets slip through their native language -- especially when you get far down the page.
- This current model of the build gets timed out after circa 850 tweets collected. The cap on tweets seems to be orthogonal to the pause and scroll length function. Looking a new account seemingly resets the limit to 850 again.
- Tweets containing Emojis are collected, but the Emojis are not retained. Tweets that are only Emojis are not retained.
- The `csv` file is coded in UTF-8. Other character encodings have not been tested.
- The scrapper does not use an OCR, if the post includes a photo, no data about the photo will be collected. A post of only a photo will not be retained.
- When you run the script, you don't need to stay on the Twitter page, you can browse on other tabs, it will still scrape. There is reason to believe that X tracks mouse movements and clicks. For the longevity of one account, I recommend being on the computer while it scrapes in hopes of further reducing the likelihood of being rate-limited, fingerprinted.
- If you accidentally click on a post, the scrapper will collect the comments of the tweets and attribute them to the author. This is because the identification process of the tweet relies on the first level of the page which does not change if you are looking at all the posts or a singular post.

## License

MIT — see [LICENSE](./LICENSE). Provided as-is, with no warranty; see the license file for full terms.

## Contributing

Issues and pull requests are welcome. If X changes their page structure and selectors break, a PR with updated `data-testid` selectors is the most useful kind of fix.
