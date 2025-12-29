# System Architecture

## Overview

The Invoice Ninja HOA Expense Automation system is a complete Business Intelligence and automation solution designed for Homeowners Associations using self-hosted Invoice Ninja instances.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     HOA Expense Automation                   │
│                                                              │
│  ┌────────────────┐      ┌──────────────────────────────┐  │
│  │   src/index.js │──────│  Main Orchestrator           │  │
│  │                │      │  - Workflow coordination     │  │
│  │                │      │  - CLI interface             │  │
│  │                │      │  - Report generation         │  │
│  └────────────────┘      └──────────────────────────────┘  │
│          │                                                   │
│          ├───────────────────┬──────────────────┬──────────┤
│          │                   │                  │          │
│  ┌───────▼────────┐  ┌──────▼─────────┐ ┌─────▼────────┐ │
│  │ Invoice Ninja  │  │  PDF Generator │ │ Email Sender │ │
│  │    Client      │  │   (JSReport)   │ │ (Nodemailer) │ │
│  └───────┬────────┘  └──────┬─────────┘ └─────┬────────┘ │
│          │                   │                  │          │
│          │           ┌───────▼──────────┐       │          │
│          │           │   Data Utils     │       │          │
│          │           │   (date-fns)     │       │          │
│          │           └──────────────────┘       │          │
└──────────┼────────────────────────────────────┼───────────┘
           │                                      │
    ┌──────▼────────┐                    ┌──────▼────────┐
    │ Invoice Ninja │                    │  SMTP Server  │
    │   Self-Hosted │                    │   (Email)     │
    │   Instance    │                    └───────────────┘
    └───────────────┘
```

## Core Components

### 1. Main Orchestrator (`src/index.js`)

**Purpose**: Coordinates the entire workflow from data retrieval to report delivery.

**Key Features**:
- CLI interface with command parsing
- Workflow orchestration
- Report generation pipeline
- Email content generation (HTML and plain text)
- Error handling and logging

**Main Methods**:
- `generateAndSendReport(options)` - Main workflow
- `testConnections()` - Verify system connectivity
- `generateEmailText()` - Create plain text email
- `generateEmailHtml()` - Create HTML email

### 2. Invoice Ninja Client (`src/lib/invoiceNinjaClient.js`)

**Purpose**: Interface with Invoice Ninja REST API.

**Key Features**:
- RESTful API communication
- Authentication with API tokens
- Comprehensive expense operations
- File upload support
- Error handling and logging

**API Methods**:
- `getExpenses(filters)` - Retrieve expenses
- `getExpense(id)` - Get single expense
- `getClients()` - Retrieve clients
- `getVendors()` - Retrieve vendors
- `getExpenseCategories()` - Get categories
- `createExpense(data)` - Create new expense
- `uploadExpenseDocument()` - Upload attachments

### 3. PDF Generator (`src/lib/pdfGenerator.js`)

**Purpose**: Generate professional PDF reports using JSReport.

**Key Features**:
- Chrome-based PDF rendering
- Custom HTML templates
- Responsive table design
- Automatic pagination
- Header and footer support
- Professional styling

**Main Methods**:
- `init()` - Initialize JSReport
- `generateExpenseReport(data)` - Create PDF report
- `createHTMLTemplate()` - Build HTML template
- `close()` - Cleanup resources

**Report Sections**:
- Header with title and period
- Summary information
- Detailed expense table
- Total calculations
- Footer with generation info

### 4. Email Sender (`src/lib/emailSender.js`)

**Purpose**: Send reports and notifications via SMTP.

**Key Features**:
- SMTP transport configuration
- HTML and plain text support
- File attachments
- Connection verification
- Error handling

**Main Methods**:
- `init()` - Setup SMTP transport
- `sendExpenseReport(options)` - Send report with PDF
- `sendNotification()` - Send simple messages
- `verifyConnection()` - Test SMTP settings

### 5. Data Utilities (`src/lib/dataUtils.js`)

**Purpose**: Data processing and date operations.

**Key Features**:
- Date range calculations
- Data filtering and sorting
- Grouping and aggregation
- Statistical analysis
- Formatting utilities

**Utility Functions**:

**Date Operations**:
- `getDateRange(period, custom)` - Calculate date ranges
- `formatPeriodString()` - Format period labels

**Filtering & Sorting**:
- `filterExpensesByDate()` - Date-based filtering
- `sortByDate()` - Sort chronologically
- `sortByAmount()` - Sort by expense amount

**Grouping**:
- `groupByCategory()` - Group by expense category
- `groupByVendor()` - Group by vendor
- `groupByMonth()` - Group by month

**Analysis**:
- `calculateTotal()` - Sum expenses
- `getExpenseStats()` - Calculate statistics

## Data Flow

### Report Generation Workflow

```
1. User Input
   ├─ CLI command or scheduled trigger
   └─ Period selection (current-month, last-month, etc.)
   
2. Date Range Calculation
   ├─ Parse period parameter
   └─ Calculate start and end dates
   
3. Data Retrieval
   ├─ Connect to Invoice Ninja API
   ├─ Fetch all expenses
   └─ Apply date filters
   
4. Data Processing
   ├─ Sort expenses by date
   ├─ Calculate statistics
   ├─ Group by category/vendor
   └─ Prepare report data
   
5. PDF Generation
   ├─ Build HTML template
   ├─ Populate with expense data
   ├─ Render with Chrome PDF
   └─ Generate PDF buffer
   
6. Email Composition
   ├─ Create email subject
   ├─ Generate HTML body
   ├─ Generate plain text body
   └─ Attach PDF report
   
7. Distribution
   ├─ Connect to SMTP server
   ├─ Send email to recipients
   └─ Save local copy (optional)
   
8. Cleanup
   └─ Close JSReport instance
```

## Technology Stack

### Runtime
- **Node.js** (v18+) with ESM modules
- Modern JavaScript (ES6+)
- Async/await patterns

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `axios` | ^1.6.0 | HTTP client for API calls |
| `jsreport-core` | ^2.10.0 | PDF generation engine |
| `jsreport-chrome-pdf` | ^1.10.0 | Chrome-based PDF rendering |
| `date-fns` | ^3.0.0 | Date manipulation and formatting |
| `form-data` | ^4.0.0 | Multipart form data for uploads |
| `nodemailer` | ^6.9.0 | SMTP email sending |
| `dotenv` | ^16.3.0 | Environment configuration |

## Configuration

### Environment Variables

The system uses a `.env` file for configuration:

```env
# Invoice Ninja API
INVOICE_NINJA_URL=https://your-instance.com
INVOICE_NINJA_TOKEN=your-api-token

# Email SMTP
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=user@example.com
EMAIL_PASSWORD=password
EMAIL_FROM=sender@example.com
EMAIL_TO=recipients@example.com

# Report Settings
REPORT_TITLE=HOA Expense Report
REPORT_PERIOD=monthly
```

### Configuration Management

1. **Development**: Use `.env` file locally
2. **CI/CD**: Use GitHub Secrets
3. **Production**: Use environment-specific variables

## Automation Options

### 1. Cron Jobs (Linux/Mac)

```bash
# Monthly on 1st at 9 AM
0 9 1 * * cd /path/to/project && npm start report last-month
```

### 2. Task Scheduler (Windows)

Use Windows Task Scheduler with:
- Trigger: Monthly, 1st day, 9:00 AM
- Action: `node src/index.js report last-month`

### 3. GitHub Actions

Automated workflow in `.github/workflows/monthly-report.yml`:
- Scheduled monthly execution
- Manual trigger support
- Secure secrets management
- Artifact upload on failure

## Security Considerations

### Authentication
- API token-based authentication for Invoice Ninja
- SMTP authentication for email
- Environment variable isolation

### Data Protection
- No sensitive data in code
- `.env` file excluded from version control
- Secure transmission (HTTPS/TLS)

### Permissions
- Minimal GitHub Actions permissions
- Read-only access where possible
- Principle of least privilege

### Dependency Security
- Regular dependency updates
- Vulnerability scanning
- Version pinning in package.json

## Error Handling

### Levels of Error Handling

1. **API Level**: Axios interceptors, retry logic
2. **Module Level**: Try-catch blocks, error logging
3. **Application Level**: Graceful degradation, user feedback

### Error Scenarios

| Scenario | Handling |
|----------|----------|
| API connection failure | Log error, throw exception |
| No expenses found | Return graceful message |
| PDF generation error | Log details, throw exception |
| Email send failure | Log error, preserve PDF locally |
| Invalid configuration | Early validation, clear error messages |

## Performance Considerations

### Optimization Strategies

1. **Async Operations**: All I/O is non-blocking
2. **Resource Management**: Proper cleanup of JSReport instances
3. **Pagination**: API results paginated when needed
4. **Caching**: Reuse API client instances

### Scalability

- **Data Volume**: Handles hundreds of expenses efficiently
- **Concurrent Reports**: Single-threaded design for simplicity
- **Resource Usage**: Minimal memory footprint
- **PDF Generation**: Chrome engine handles complex reports

## Monitoring & Logging

### Console Logging

- Connection status updates
- Progress indicators
- Error messages with context
- Success confirmations

### Potential Enhancements

- Structured logging (Winston, Bunyan)
- Log file rotation
- Error tracking (Sentry)
- Performance metrics

## Extension Points

### Easy Customizations

1. **PDF Styling**: Edit `pdfGenerator.js` HTML template
2. **Email Content**: Modify email generation methods
3. **Data Grouping**: Add new grouping functions
4. **Report Periods**: Add custom period types
5. **API Methods**: Extend Invoice Ninja client

### Integration Options

1. **Webhooks**: Add webhook notifications
2. **Database**: Store historical reports
3. **Cloud Storage**: Upload PDFs to S3/GCS
4. **Analytics**: Export data to BI tools
5. **Slack/Teams**: Send notifications to chat

## Testing Strategy

### Current Testing

- Syntax validation with Node.js
- Module import testing
- Connection testing (`npm start test`)

### Future Testing

- Unit tests (Jest/Mocha)
- Integration tests
- E2E automation tests
- PDF content validation
- Mock API responses

## Deployment

### Local Development

```bash
npm install
cp .env.example .env
# Edit .env
npm start test
npm start report current-month
```

### Production Deployment

1. Set up environment variables
2. Configure automation (cron/GitHub Actions)
3. Set up monitoring
4. Document runbook procedures

## Maintenance

### Regular Tasks

- Monitor scheduled runs
- Review error logs
- Update dependencies
- Rotate credentials
- Archive old reports

### Upgrade Path

- Check for Invoice Ninja API changes
- Update dependencies quarterly
- Review security advisories
- Test before production updates

## Support & Documentation

### Documentation Files

- `README.md` - Main documentation
- `QUICKSTART.md` - Getting started guide
- `CONTRIBUTING.md` - Contribution guidelines
- `ARCHITECTURE.md` - This file
- `src/examples.js` - Usage examples

### Getting Help

1. Check documentation first
2. Review example code
3. Test connections with `npm start test`
4. Open GitHub issue with details

## Future Roadmap

### Potential Features

1. **Web Dashboard**: View reports in browser
2. **Multiple HOAs**: Support multiple Invoice Ninja instances
3. **Custom Reports**: Configurable report templates
4. **Data Export**: CSV, Excel, JSON exports
5. **Budget Tracking**: Compare against budgets
6. **Forecasting**: Expense predictions
7. **Mobile App**: View reports on mobile
8. **API Server**: Expose report generation as API

### Technical Improvements

1. **TypeScript**: Type safety
2. **Testing**: Comprehensive test suite
3. **Docker**: Containerized deployment
4. **Observability**: Metrics and tracing
5. **Queue System**: Handle batch reports
6. **Caching**: Redis for performance

---

**Version**: 1.0.0  
**Last Updated**: December 2025  
**Maintainer**: Invoice Ninja HOA Automation Team
