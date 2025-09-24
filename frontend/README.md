# ShopList Frontend

Modern, responsive frontend for the ShopList inventory management system.

## Features

- **Modern Design**: Clean, professional interface with smooth animations
- **Responsive Layout**: Works perfectly on desktop, tablet, and mobile devices
- **Real-time Search**: Instant product filtering as you type
- **Dashboard Stats**: Quick overview of inventory metrics
- **Modal Editing**: Intuitive product editing experience
- **Loading States**: Smooth loading indicators and error handling

## Technology Stack

- **Vanilla JavaScript**: No frameworks - pure, fast JavaScript
- **Modern CSS**: CSS Grid, Flexbox, custom properties, animations
- **Font Awesome**: Professional icon set
- **Fetch API**: Modern HTTP client for API communication

## File Structure

```
frontend/
├── css/
│   └── styles.css      # Main stylesheet with modern design
├── js/
│   ├── api.js          # API service layer
│   └── app.js          # Main application logic
├── index.html          # Main HTML file
├── package.json        # Frontend dependencies
└── README.md          # This file
```

## Key Components

### API Service (`js/api.js`)
- Centralized API communication
- Error handling and response parsing
- RESTful endpoints for products

### Application Logic (`js/app.js`)
- State management
- DOM manipulation
- Event handling
- Product CRUD operations

### Styling (`css/styles.css`)
- Mobile-first responsive design
- CSS Grid for layouts
- Smooth animations and transitions
- Modern color scheme and typography

## Development

### Running Locally
```bash
# Install frontend dependencies
npm install

# Start development server
npm run dev
```

### Building for Production
The frontend is served as static files by the Express server, so no build step is required.

## Browser Support

- Chrome 60+
- Firefox 55+
- Safari 12+
- Edge 79+

## Performance Features

- Minimal JavaScript bundle
- CSS animations for smooth interactions
- Efficient DOM updates
- Lazy loading of non-critical resources

## Accessibility

- Semantic HTML structure
- Keyboard navigation support
- Screen reader friendly
- High contrast color scheme
- Focus indicators

## Customization

### Colors
Update CSS custom properties in `styles.css`:
```css
:root {
  --primary-color: #667eea;
  --secondary-color: #764ba2;
  --success-color: #28a745;
  --danger-color: #dc3545;
}
```

### Layout
Modify the grid layouts:
```css
.stats-grid {
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
}

.products-grid {
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
}
```

## API Integration

The frontend communicates with the backend API at `/api/products`:

- `GET /api/products` - Fetch all products
- `POST /api/products` - Create new product
- `PUT /api/products/:id` - Update product
- `DELETE /api/products/:id` - Delete product

## Contributing

1. Follow the existing code style
2. Test on multiple browsers
3. Ensure responsive design works
4. Add comments for complex logic
5. Update this README if needed