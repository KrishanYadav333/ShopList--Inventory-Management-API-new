// Application State
class AppState {
    constructor() {
        this.products = [];
        this.filteredProducts = [];
        this.searchTerm = '';
        this.isLoading = false;
    }

    setProducts(products) {
        this.products = products;
        this.filterProducts();
        this.updateStats();
    }

    filterProducts() {
        this.filteredProducts = this.products.filter(product => {
            const matchesSearch = !this.searchTerm || 
                product.name.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
                product.sku.toLowerCase().includes(this.searchTerm.toLowerCase());
            return matchesSearch;
        });
    }

    updateStats() {
        const totalProducts = this.products.length;
        const totalValue = this.products.reduce((sum, product) => sum + (product.price * product.quantity), 0);
        const lowStock = this.products.filter(product => product.quantity < 10).length;

        document.getElementById('totalProducts').textContent = totalProducts;
        document.getElementById('totalValue').textContent = `$${totalValue.toFixed(2)}`;
        document.getElementById('lowStock').textContent = lowStock;
    }
}

// Global app state
const appState = new AppState();

// DOM Elements
const elements = {
    productForm: document.getElementById('productForm'),
    searchInput: document.getElementById('searchInput'),
    searchBtn: document.getElementById('searchBtn'),
    productsContainer: document.getElementById('productsContainer'),
    editModal: document.getElementById('editModal'),
    editForm: document.getElementById('editForm')
};

// Utility Functions
function showLoading() {
    elements.productsContainer.innerHTML = `
        <div class="loading">
            <i class="fas fa-spinner fa-spin"></i>
            <h3>Loading your inventory...</h3>
            <p>Please wait while we fetch your products</p>
        </div>
    `;
}

function showError(message) {
    elements.productsContainer.innerHTML = `
        <div class="empty-state">
            <i class="fas fa-exclamation-triangle" style="color: #f5576c;"></i>
            <h3>Oops! Something went wrong</h3>
            <p>Error: ${message}</p>
            <button class="btn-primary" onclick="loadProducts()" style="margin-top: 1rem;">
                <i class="fas fa-refresh"></i> Try Again
            </button>
        </div>
    `;
}

function showEmptyState() {
    elements.productsContainer.innerHTML = `
        <div class="empty-state">
            <i class="fas fa-box-open"></i>
            <h3>Your inventory is empty</h3>
            <p>Start building your inventory by adding your first product above</p>
            <div style="margin-top: 1.5rem;">
                <i class="fas fa-arrow-up" style="font-size: 2rem; color: var(--text-muted); animation: bounce 2s infinite;"></i>
            </div>
        </div>
    `;
}

function getQuantityClass(quantity) {
    if (quantity >= 20) return 'quantity-high';
    if (quantity >= 10) return 'quantity-medium';
    return 'quantity-low';
}

function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount);
}

// Product Management Functions
async function loadProducts() {
    try {
        showLoading();
        appState.isLoading = true;
        
        const response = await api.getProducts();
        appState.setProducts(response.products || []);
        renderProducts();
    } catch (error) {
        console.error('Failed to load products:', error);
        showError(error.message);
    } finally {
        appState.isLoading = false;
    }
}

function renderProducts() {
    if (appState.filteredProducts.length === 0) {
        showEmptyState();
        return;
    }

    const productsHTML = appState.filteredProducts.map((product, index) => `
        <div class="product-card" style="animation-delay: ${index * 0.1}s">
            <div class="product-header">
                <div>
                    <h3 class="product-title">${escapeHtml(product.name)}</h3>
                    <span class="product-sku">SKU: ${escapeHtml(product.sku)}</span>
                </div>
                <div class="product-price">${formatCurrency(product.price)}</div>
            </div>
            
            ${product.description ? `<p class="product-description">${escapeHtml(product.description)}</p>` : ''}
            
            <div class="product-quantity">
                <i class="fas fa-cubes"></i>
                <span>Stock: </span>
                <span class="quantity-badge ${getQuantityClass(product.quantity)}">
                    <i class="fas fa-box"></i> ${product.quantity} units
                </span>
            </div>
            
            <div class="product-actions">
                <button class="btn-edit" onclick="editProduct(${product.id})" title="Edit Product">
                    <i class="fas fa-edit"></i> Edit
                </button>
                <button class="btn-danger" onclick="deleteProduct(${product.id})" title="Delete Product">
                    <i class="fas fa-trash-alt"></i> Delete
                </button>
            </div>
        </div>
    `).join('');

    elements.productsContainer.innerHTML = `
        <div class="products-grid">
            ${productsHTML}
        </div>
    `;

    // Add stagger animation to product cards
    const cards = document.querySelectorAll('.product-card');
    cards.forEach((card, index) => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(30px)';
        setTimeout(() => {
            card.style.transition = 'all 0.6s cubic-bezier(0.4, 0, 0.2, 1)';
            card.style.opacity = '1';
            card.style.transform = 'translateY(0)';
        }, index * 100);
    });
}

async function addProduct(event) {
    event.preventDefault();
    
    const formData = new FormData(event.target);
    const productData = {
        name: formData.get('name'),
        description: formData.get('description') || null,
        price: parseFloat(formData.get('price')),
        quantity: parseInt(formData.get('quantity')),
        sku: formData.get('sku')
    };

    // Validation
    if (!productData.name || !productData.sku || isNaN(productData.price) || isNaN(productData.quantity) || productData.price < 0 || productData.quantity < 0) {
        alert('Please fill in all required fields with valid values');
        return;
    }

    try {
        await api.createProduct(productData);
        event.target.reset();
        await loadProducts();
        showNotification('Product added successfully!', 'success');
    } catch (error) {
        console.error('Failed to add product:', error);
        showNotification(error.message, 'error');
    }
}

async function editProduct(id) {
    try {
        const product = appState.products.find(p => p.id === id);
        if (!product) {
            throw new Error('Product not found');
        }

        // Populate edit form
        document.getElementById('editProductId').value = product.id;
        document.getElementById('editProductName').value = product.name;
        document.getElementById('editProductDescription').value = product.description || '';
        document.getElementById('editProductPrice').value = product.price;
        document.getElementById('editProductQuantity').value = product.quantity;
        document.getElementById('editProductSku').value = product.sku;

        // Show modal
        elements.editModal.style.display = 'block';
    } catch (error) {
        console.error('Failed to load product for editing:', error);
        showNotification(error.message, 'error');
    }
}

async function updateProduct(event) {
    event.preventDefault();
    
    const id = document.getElementById('editProductId').value;
    const productData = {
        name: document.getElementById('editProductName').value,
        description: document.getElementById('editProductDescription').value,
        price: parseFloat(document.getElementById('editProductPrice').value),
        quantity: parseInt(document.getElementById('editProductQuantity').value),
        sku: document.getElementById('editProductSku').value
    };

    // Validation
    if (!productData.name || !productData.sku || productData.price < 0 || productData.quantity < 0) {
        alert('Please fill in all required fields with valid values');
        return;
    }

    try {
        await api.updateProduct(id, productData);
        closeEditModal();
        await loadProducts();
        showNotification('Product updated successfully!', 'success');
    } catch (error) {
        console.error('Failed to update product:', error);
        showNotification(error.message, 'error');
    }
}

async function deleteProduct(id) {
    if (!confirm('Are you sure you want to delete this product?')) {
        return;
    }

    try {
        await api.deleteProduct(id);
        await loadProducts();
        showNotification('Product deleted successfully!', 'success');
    } catch (error) {
        console.error('Failed to delete product:', error);
        showNotification(error.message, 'error');
    }
}

function searchProducts() {
    appState.searchTerm = elements.searchInput.value.trim();
    appState.filterProducts();
    renderProducts();
}

function closeEditModal() {
    elements.editModal.style.display = 'none';
}

// Utility Functions
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `notification notification-${type}`;
    
    const icons = {
        success: 'check-circle',
        error: 'times-circle',
        info: 'info-circle',
        warning: 'exclamation-triangle'
    };
    
    notification.innerHTML = `
        <i class="fas fa-${icons[type] || icons.info}"></i>
        <div>
            <div style="font-weight: 600; margin-bottom: 2px;">
                ${type === 'success' ? 'Success!' : type === 'error' ? 'Error!' : 'Info'}
            </div>
            <div style="font-size: 0.9rem; opacity: 0.9;">${message}</div>
        </div>
        <button onclick="this.parentElement.remove()" style="background: none; border: none; color: inherit; cursor: pointer; padding: 4px; margin-left: auto;">
            <i class="fas fa-times"></i>
        </button>
    `;

    document.body.appendChild(notification);

    // Auto-remove after 4 seconds
    setTimeout(() => {
        if (notification.parentElement) {
            notification.style.animation = 'slideOutRight 0.3s ease forwards';
            setTimeout(() => notification.remove(), 300);
        }
    }, 4000);

    // Add slide out animation
    if (!document.getElementById('notification-animations')) {
        const styles = document.createElement('style');
        styles.id = 'notification-animations';
        styles.textContent = `
            @keyframes slideOutRight {
                from { transform: translateX(0); opacity: 1; }
                to { transform: translateX(100%); opacity: 0; }
            }
            @keyframes bounce {
                0%, 20%, 50%, 80%, 100% { transform: translateY(0); }
                40% { transform: translateY(-10px); }
                60% { transform: translateY(-5px); }
            }
        `;
        document.head.appendChild(styles);
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', function() {
    // Form submissions
    elements.productForm.addEventListener('submit', addProduct);
    elements.editForm.addEventListener('submit', updateProduct);

    // Search functionality
    elements.searchInput.addEventListener('input', searchProducts);
    elements.searchBtn.addEventListener('click', searchProducts);

    // Modal close events
    elements.editModal.querySelector('.close').addEventListener('click', closeEditModal);
    window.addEventListener('click', function(event) {
        if (event.target === elements.editModal) {
            closeEditModal();
        }
    });

    // Add floating label effect to form inputs
    const inputs = document.querySelectorAll('input, textarea');
    inputs.forEach(input => {
        input.addEventListener('focus', function() {
            this.parentElement.classList.add('focused');
        });
        
        input.addEventListener('blur', function() {
            if (!this.value) {
                this.parentElement.classList.remove('focused');
            }
        });
    });

    // Add keyboard shortcuts
    document.addEventListener('keydown', function(e) {
        // Escape key to close modal
        if (e.key === 'Escape' && elements.editModal.style.display === 'block') {
            closeEditModal();
        }
        
        // Ctrl/Cmd + K to focus search
        if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
            e.preventDefault();
            elements.searchInput.focus();
        }
    });

    // Add smooth scroll behavior
    document.documentElement.style.scrollBehavior = 'smooth';

    // Load initial data with welcome message
    loadProducts();
    
    // Show welcome notification after a short delay
    setTimeout(() => {
        showNotification('Welcome to ShopList! Your modern inventory management system.', 'info');
    }, 1000);
});

// Global functions for inline event handlers
window.editProduct = editProduct;
window.deleteProduct = deleteProduct;
window.closeEditModal = closeEditModal;