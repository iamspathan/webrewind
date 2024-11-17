const express  = require('express');

const port = 3200;

const app  = express();

app.get('/test', (req, res) =>{
   res.send({ date: "This is returned from server"}); 
})

app.listen( port, ()=> {
    console.log(`Server is running on ${port}`);
});