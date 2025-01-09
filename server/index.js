const express = require("express");
const puppeteer = require('puppeteer');
const fs = require('fs')
const cors = require('cors');
const {createWriteStream , readdir} = require('fs');
const { getURLs } = require('./util/wayback');
const { exec } = require('child_process');
const GIFEncoder = require('gif-encoder-2');
const path = require('path');
const { createCanvas, Image } = require('canvas');
const { promisify } = require('util');
const cloudflarestorage = require('./util/cloudflare');
const { console } = require("inspector");
const swaggerJSDoc = require("swagger-jsdoc");
const swaggerUi  = require('swagger-ui-express');


const swaggerOptions = {
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'Webrewind API',
      version: '1.0.0',
      description: 'API Documentation',
    },
    servers: [
      {
        url: 'http://localhost:3200', // Replace with your server URL
      },
    ],
  },
  apis: ['./index.js'], // Path to the API docs
};

// Initialize Swagger JSDoc
const swaggerDocs = swaggerJSDoc(swaggerOptions);
// Write the specification to a file in the docs folder
const docsFolderPath = path.resolve(__dirname, 'docs');
if (!fs.existsSync(docsFolderPath)) {
  fs.mkdirSync(docsFolderPath);
}
fs.writeFileSync(path.join(docsFolderPath, 'openapi.json'), JSON.stringify(swaggerDocs, null, 2));

const port = process.env.port || 3200;

const app = express();

app.use(express.json());

app.use(cors({
  origin: 'http://localhost:5173', // Replace with your frontend's origin
  methods: ['GET', 'POST'], // Specify the methods you want to allow, // Specify the headers you want to allow
}))

// Set up Swagger UI
app.use('/', swaggerUi.serve, swaggerUi.setup(swaggerDocs));


/**
   * @swagger
   * /test:
   *   get:
   *     summary: Test endpoint
   *     responses:
   *       200:
   *         description: A successful response
   */
app.get("/test", (req, res) => {
  res.send({ date: "This is returned from server" });
});

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


app.get("/folders", async (req, res) => {

 const folders =  cloudflarestorage.listFolders;

 console.log(folders);
})

/**
 * @swagger
 * /screenshots:
 *   post:
 *     summary: Generate screenshots and return image paths
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               url:
 *                 type: string
 *                 description: The URL to capture screenshots from
 *               startYear:
 *                 type: integer
 *                 description: The start year for capturing screenshots
 *               endYear:
 *                 type: integer
 *                 description: The end year for capturing screenshots
 *               outputFileName:
 *                 type: string
 *                 description: The base name for output files
 *     responses:
 *       200:
 *         description: A list of image paths
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 images:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Missing required parameters
 *       404:
 *         description: No images found
 *       500:
 *         description: An error occurred while taking screenshots or creating GIF
 */
app.post("/screenshots", async (req, res) => {
  const { url, startYear, endYear, outputFileName } = req.body;

  if (!url || !startYear || !endYear || !outputFileName) {
    return res.status(400).send("Missing required parameters");
  }

  try {
    // await run(url, startYear, endYear, outputFileName);
    // console.log(outputFileName);
    // const gifPath = await createGifFromScreenshots(`screenshots-${outputFileName}`, outputFileName);
    // const absoluteGifPath = path.resolve(gifPath);
    // res.status(200).sendFile(absoluteGifPath);

    console.log(outputFileName);
    const screenshotFolderName = `screenshots-${outputFileName}`;
    const files = await readdirAsync(screenshotFolderName);
    const pngFiles = files.filter(file => file.endsWith('.png'));

    if (pngFiles.length === 0) {
      return res.status(404).send("No images found");
    }

    const imagePaths = pngFiles.map(file => path.resolve(screenshotFolderName, file));
    res.status(200).json({ images: imagePaths });


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
