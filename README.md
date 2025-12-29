# Invoice Ninja HOA Expense Automation

Business Intelligence and automation system for HOA (Homeowners Association) using self-hosted Invoice Ninja.

## Overview

This system automates the process of generating and distributing expense reports for a Homeowners Association. It connects to a self-hosted Invoice Ninja instance, retrieves expense data, generates professional PDF reports, and emails them to stakeholders.

## Features

- 🔗 **Invoice Ninja Integration** - Connects to self-hosted Invoice Ninja via REST API
- 📊 **Data Processing** - Advanced filtering, grouping, and analysis of expenses
- 📄 **PDF Generation** - Professional PDF reports using JSReport and Chrome PDF
- 📧 **Email Distribution** - Automated email delivery with attachments
- 📅 **Date Management** - Flexible date range selection and filtering
- 🏷️ **Categorization** - Group expenses by category, vendor, or time period
- 📈 **Statistics** - Comprehensive expense statistics and summaries

## Technology Stack

- **Runtime**: Node.js (ESM)
- **Language**: TypeScript
- **HTTP Client**: Axios
- **PDF Generation**: JSReport-core + JSReport-chrome-pdf
- **Date Handling**: date-fns
- **File Upload**: form-data
- **Email**: Nodemailer
- **Configuration**: dotenv

## Installation

1. Clone the repository:
```bash
git clone https://github.com/luisogandob/invoiceninja-hoa-inform.git
cd invoiceninja-hoa-inform
```

2. Install dependencies:
```bash
npm install
```

3. Configure environment variables:
```bash
cp .env.example .env
```

Edit `.env` and set your configuration:
- Invoice Ninja URL and API token
- Email SMTP settings
- Report preferences

## Configuration

### Invoice Ninja Setup

1. Log in to your self-hosted Invoice Ninja instance
2. Go to Settings > Account Management > API Tokens
3. Create a new API token
4. Copy the token to your `.env` file

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `INVOICE_NINJA_URL` | Your Invoice Ninja instance URL | `https://invoice.example.com` |
| `INVOICE_NINJA_TOKEN` | API token from Invoice Ninja | `your-api-token` |
| `EMAIL_HOST` | SMTP server hostname | `smtp.gmail.com` |
| `EMAIL_PORT` | SMTP server port | `587` |
| `EMAIL_SECURE` | Use TLS/SSL | `false` |
| `EMAIL_USER` | SMTP username | `your-email@example.com` |
| `EMAIL_PASSWORD` | SMTP password | `your-password` |
| `EMAIL_FROM` | Sender email address | `hoa@example.com` |
| `EMAIL_TO` | Default recipient email(s) | `recipients@example.com` |
| `REPORT_TITLE` | Report title | `HOA Expense Report` |
| `REPORT_PERIOD` | Default report period | `current-month` |

## Usage

### Test Connections

Verify that the system can connect to Invoice Ninja and your email server:

```bash
npm start test
```

### Generate Reports

Generate and send a report for the current month:

```bash
npm start
```

Generate a report for a specific period:

```bash
npm start report last-month
npm start report current-year
npm start report last-year
```

Available periods:
- `current-month` - Current calendar month
- `last-month` - Previous calendar month
- `current-year` - Current calendar year
- `last-year` - Previous calendar year

### Development Mode

Run with auto-reload on file changes (TypeScript):

```bash
npm run dev
```

### Build

Compile TypeScript to JavaScript:

```bash
npm run build
```

The compiled code will be in the `dist/` directory.

### Type Checking

Run TypeScript type checking without building:

```bash
npm run typecheck
```

## Project Structure

```
invoiceninja-hoa-expense-automation/
├── src/
│   ├── index.ts                  # Main application entry point
│   ├── examples.ts               # Usage examples
│   └── lib/
│       ├── invoiceNinjaClient.ts # Invoice Ninja API client
│       ├── pdfGenerator.ts       # PDF report generation
│       ├── emailSender.ts        # Email sending functionality
│       └── dataUtils.ts          # Data processing utilities
├── dist/                         # Compiled JavaScript (generated)
├── .env.example                  # Environment configuration template
├── tsconfig.json                 # TypeScript configuration
├── package.json                  # Project dependencies and scripts
└── README.md                     # This file
```

## API Modules

### InvoiceNinjaClient

Handles all interactions with the Invoice Ninja API:

- `getExpenses(filters)` - Retrieve expenses with optional filtering
- `getExpense(expenseId)` - Get a single expense by ID
- `getClients()` - Retrieve all clients
- `getVendors()` - Retrieve all vendors
- `getExpenseCategories()` - Retrieve expense categories
- `createExpense(data)` - Create a new expense
- `uploadExpenseDocument(expenseId, buffer, filename)` - Upload documents

### PDFGenerator

Generates professional PDF reports:

- `generateExpenseReport(reportData)` - Create a formatted expense report
- Includes header, expense table, totals, and footer
- Automatic pagination and formatting

### EmailSender

Manages email distribution:

- `sendExpenseReport(options)` - Send report with PDF attachment
- `sendNotification(to, subject, message)` - Send simple notifications
- `verifyConnection()` - Test email configuration

### DataUtils

Utility functions for data processing:

- `getDateRange(period, customRange)` - Calculate date ranges
- `filterExpensesByDate(expenses, start, end)` - Filter by date
- `calculateTotal(expenses)` - Sum expense amounts
- `groupByCategory(expenses)` - Group expenses by category
- `groupByVendor(expenses)` - Group expenses by vendor
- `groupByMonth(expenses)` - Group expenses by month
- `sortByDate(expenses, order)` - Sort by date
- `sortByAmount(expenses, order)` - Sort by amount
- `getExpenseStats(expenses)` - Calculate statistics

## Report Features

### PDF Report Includes

- Professional header with title and period
- Expense table with:
  - Date
  - Description
  - Vendor
  - Category
  - Amount
- Total amount calculation
- Automatic pagination with page numbers
- Clean, professional formatting

### Email Report Includes

- Summary statistics (count, total, average, min, max)
- Expenses grouped by category
- PDF attachment
- HTML and plain text versions

## Automation Ideas

You can automate report generation using:

### Cron Job (Linux/Mac)

```bash
# Run monthly report on the 1st of each month at 9 AM
0 9 1 * * cd /path/to/project && npm start report last-month
```

### Task Scheduler (Windows)

Create a scheduled task to run:
```
node src/index.js report last-month
```

### GitHub Actions

Use GitHub Actions to run reports on a schedule.

## Troubleshooting

### Connection Issues

1. Verify Invoice Ninja URL is correct and accessible
2. Check API token is valid and has proper permissions
3. Test email SMTP settings with a email client
4. Run `npm start test` to diagnose connection issues

### Missing Dependencies

```bash
npm install
```

### Permission Errors

Ensure the application has write permissions for PDF generation.

## Security Notes

- Never commit `.env` file to version control
- Keep API tokens secure
- Use environment-specific credentials
- Regularly rotate API tokens
- Use app-specific passwords for email when possible

## License

MIT License - see LICENSE file for details

## Support

For issues and questions, please open an issue on GitHub.
