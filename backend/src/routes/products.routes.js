const express = require('express');
const c = require('../controllers/product.controller');

const router = express.Router();

// All routes are public for demo purposes
router.get('/', c.getProducts);
router.get('/:id', c.getProductById);
router.post('/', c.createProduct);
router.put('/:id', c.updateProduct);
router.delete('/:id', c.deleteProduct);

module.exports = router;