// const AWS  =  require('aws-sdk');
// const crypto =  require('crypto');

// const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
// const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
// const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
// const BUCKET_NAME = process.env.R2_BUCKET_NAME;

// const hashedSecretKey = crypto.createHash('sha256').update(SECRET_ACCESS_KEY).digest('hex');
// const s3Client = new AWS.S3({
//     endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
//     accessKeyId: ACCESS_KEY_ID,
//     secretAccessKey: hashedSecretKey,
//     signatureVersion: 'v4',
//     region: 'auto' // Cloudflare R2 doesn't use regions, but this is required by the SDK
// });


// export async function fetchObject(objectKey) {
//     try {
//         const params = {
//             Bucket: BUCKET_NAME,
//             Key: objectKey
//         };

//         const data = await s3Client.getObject(params).promise();
//         console.log('Successfully fetched the object', data.Body);

//         // Process the data as needed
//         // For example, to get the content as a Buffer:
//         // const content = data.Body;

//         // Or to save the file (requires 'fs' module):
//         // const fs = require('fs').promises;
//         // await fs.writeFile('ingested_0001.parquet', data.Body);

//     } catch (error) {
//         console.error('Failed to fetch the object:', error);
//     }
    
// }


// // ... existing code ...

// export async function listFolders() {
//     try {
//         const params = {
//             Bucket: BUCKET_NAME,
//             Delimiter: '/' // This will group objects by folder
//         };

//         const data = await s3Client.listObjectsV2(params).promise();
//         const folders = data.CommonPrefixes.map(prefix => prefix.Prefix);

//         console.log('Folders:', folders);
//         return folders;

//     } catch (error) {
//         console.error('Failed to list folders:', error);
//     }
// }

// // ... existing code ...
