# Contributing to Invoice Ninja HOA Financial Reporting

Thank you for considering contributing to this project!

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a feature branch: `git checkout -b feature/my-feature`
4. Make your changes
5. Test your changes
6. Commit with clear messages: `git commit -m "Add feature X"`
7. Push to your fork: `git push origin feature/my-feature`
8. Create a Pull Request

## Development Setup

```bash
# Clone the repository
git clone https://github.com/luisogandob/invoiceninja-hoa-inform.git
cd invoiceninja-hoa-inform

# Install dependencies
npm install

# Create .env file
cp .env.example .env
# Edit .env with your configuration

# Test the setup
npm start test
```

## Code Style

- Use TypeScript with proper typing
- Use ES6+ features (this is an ESM project)
- Use meaningful variable and function names
- Add comments for complex logic
- Follow the existing code structure
- Use async/await for asynchronous operations

## Testing

Before submitting a PR:

1. Ensure all existing functionality works
2. Test with the `test` command: `npm start test`
3. Test report generation with different periods
4. Verify PDF generation works correctly with both income and expenses
5. Verify email sending works correctly
6. Run type checking: `npm run typecheck`
7. Build the project: `npm run build`

## Submitting Changes

1. Ensure your code follows the project's code style
2. Update documentation if needed
3. Add examples if introducing new features
4. Write clear commit messages
5. Reference any related issues in your PR description

## Reporting Issues

When reporting issues, please include:

- Node.js version
- Invoice Ninja version
- Error messages and stack traces
- Steps to reproduce
- Expected vs actual behavior

## Feature Requests

We welcome feature requests! Please:

- Check if the feature already exists
- Clearly describe the feature and its use case
- Explain why it would be valuable
- Consider submitting a PR implementing it

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Focus on the code, not the person
- Help others learn and grow

## Questions?

Open an issue with the "question" label.

Thank you for contributing! 🎉
