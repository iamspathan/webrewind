const express = require("express");
const puppeteer = require('puppeteer');
const fs = require('fs')
const {createWriteStream , readdir} = require('fs');
const { getURLs } = require('./wayback');
const { exec } = require('child_process');
const GIFEncoder = require('gif-encoder-2');
const path = require('path');
const { createCanvas, Image } = require('canvas');
const { promisify } = require('util');

const port = process.env.port || 3200;

const app = express();

app.use(express.json());

const readdirAsync = promisify(readdir);

async function takeScreenshotOfPage(
  url,
  browser,
  page,
  filename,
  screenshotFolderName
) {
  console.log("taking screenshot of ", url);

  await page.goto(`${url}`, {
    /// domcontentloaded
    /// networkidle0
    /// load
    timeout: 60000,
    waitUntil: "networkidle0",
  });

  ///Wait for Wayback navigation to appear in DOM then delete it
  await page.waitForXPath(`//*[@id="wm-ipp-base"]`);
  await page.evaluate(async (ID) => {
    //   const selectors = Array.from(document.querySelectorAll("img"));
    //   await Promise.all(selectors.map(img => {
    //   if (img.complete) return;
    //   return new Promise((resolve, reject) => {
    //     img.addEventListener('load', resolve);
    //     img.addEventListener('error', reject);
    //   });
    // }));

    var element = document.getElementById(ID);
    element.parentNode.removeChild(element);
  }, "wm-ipp-base");

  await page.screenshot({ path: `${screenshotFolderName}/${filename}.png` });
}

async function run(url, startYear, endYear, outputFileName) {
  const maxNumberOfCaptures = 300;
  const screenshotFolderName = `screenshots-${outputFileName}`;
  const startIndex = 0;
  const collapse = "timestamp:6";
  const windowSize = { width: 1366, height: 1366 };

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewport(windowSize);

  page.on("dialog", async (dialog) => {
    console.log(dialog.type());
    console.log(dialog.message());
    await dialog.accept();
  });

  let urls = await getURLs(
    url,
    maxNumberOfCaptures,
    startYear,
    endYear,
    collapse
  );
  console.log("urls", urls);

  let count = startIndex;
  console.assert(
    startIndex < urls.length,
    "startIndex is greater than the number of urls"
  );

  if (!fs.existsSync(screenshotFolderName)) {
    console.log(`Creating folder ${screenshotFolderName}`);
    fs.mkdirSync(screenshotFolderName);
  } else {
    console.log(`Deleting folder ${screenshotFolderName}`);
    exec(`rm -rf ${screenshotFolderName}`, (err, stdout, stderr) => {
      if (err) {
        console.log(`Error deleting folder ${screenshotFolderName}`);
        return;
      }
      console.log(`Deleted folder ${screenshotFolderName}`);
      fs.mkdirSync(screenshotFolderName);
    });
  }

  let metaDataPath = `${screenshotFolderName}/imageInfo-${screenshotFolderName}.txt`;

  if (fs.existsSync(metaDataPath)) {
    fs.unlinkSync(metaDataPath);
  } else {
    console.log(`Creating file ${metaDataPath}`);
    fs.writeFileSync(metaDataPath, "");
  }

  for (let url of urls.slice(startIndex)) {
    try {
      await takeScreenshotOfPage(
        url,
        browser,
        page,
        count,
        screenshotFolderName
      );
      let timestamp = url.split("/")[4];
      fs.appendFileSync(metaDataPath, `${url} ${count} ${timestamp}` + "\n");
      count++;
    } catch (e) {
      console.log(e);
    }
  }

  browser.close();
}

async function createGifFromScreenshots(screenshotFolderName, outputFileName) {
  const files = await readdirAsync(screenshotFolderName);
  const pngFiles = files.filter(file => file.endsWith('.png'));

  if (pngFiles.length === 0) {
    throw new Error('No PNG files found in the directory');
  }

  const [width, height] = await new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve([image.width, image.height]);
    image.src = path.join(screenshotFolderName, pngFiles[0]);
  });

  const gifPath = path.join(screenshotFolderName, `${outputFileName}.gif`);
  const writeStream = createWriteStream(gifPath);

  const encoder = new GIFEncoder(width, height, 'neuquant');
  encoder.createReadStream().pipe(writeStream);
  encoder.start();
  encoder.setDelay(500); // frame delay in ms

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  for (const file of pngFiles) {
    await new Promise(resolve => {
      const image = new Image();
      image.onload = () => {
        ctx.drawImage(image, 0, 0);
        encoder.addFrame(ctx);
        resolve();
      };
      image.src = path.join(screenshotFolderName, file);
    });
  }

  encoder.finish();
  return gifPath;
}


app.post("/screenshots", async (req, res) => {
  const { url, startYear, endYear, outputFileName } = req.body;

  if (!url || !startYear || !endYear || !outputFileName) {
    return res.status(400).send("Missing required parameters");
  }

  try {
    // await run(url, startYear, endYear, outputFileName);
    console.log(outputFileName);
    const gifPath = await createGifFromScreenshots(`screenshots-${outputFileName}`, outputFileName);
    const absoluteGifPath = path.resolve(gifPath);
    res.status(200).sendFile(absoluteGifPath);
  } catch (error) {
    console.error(error);
    res.status(500).send("An error occurred while taking screenshots or creating GIF");
  }
});

app.get("/test", (req, res) => {
  res.send({ date: "This is returned from server" });
});

app.listen(port, () => {
  console.log(`Server is running on ${port}`);
});
