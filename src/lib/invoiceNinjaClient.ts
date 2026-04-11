import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

/**
 * Callback invoked after each page is fetched.
 * @param page       The 1-based current page number.
 * @param totalPages Total number of pages (null if unknown).
 * @param fetched    Cumulative number of records fetched so far.
 */
export type OnPageFetched = (page: number, totalPages: number | null, fetched: number) => void;

/**
 * Invoice Ninja API Response wrapper
 */
interface ApiResponse<T> {
  data: T;
  meta?: {
    pagination?: {
      total: number;
      count: number;
      per_page: number;
      current_page: number;
      total_pages: number;
    };
  };
}

/**
 * Expense interface
 */
export interface Expense {
  id?: string;
  /** Expense document number assigned by Invoice Ninja (e.g. "EXP-0001") */
  number?: string;
  amount: number;
  date?: string;
  expense_date?: string;
  /**
   * Date this expense was paid by the organisation (YYYY-MM-DD).
   * Empty string / undefined means the expense has NOT been paid yet.
   */
  payment_date?: string;
  /** Invoice Ninja vendor ID (foreign key to vendors endpoint) */
  vendor_id?: string;
  /** Invoice Ninja expense category ID (foreign key to expense_categories endpoint) */
  category_id?: string;
  /** Invoice Ninja client ID linked to this expense */
  client_id?: string;
  /** True when the record has been soft-deleted in Invoice Ninja */
  is_deleted?: boolean;
  public_notes?: string;
  description?: string;
  vendor_name?: string;
  vendor?: {
    name: string;
  };
  category_name?: string;
  category?: {
    name: string;
  };
  client_name?: string;
}

/**
 * Client contact interface (Invoice Ninja v5 embeds contacts in client objects)
 */
export interface ClientContact {
  id: string;
  client_id?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  /** True when this contact is the primary/default contact for the client */
  is_primary?: boolean;
}

/**
 * Client interface
 */
export interface Client {
  id: string;
  name: string;
  /** ID of the Group Settings record this client belongs to (optional) */
  group_settings_id?: string;
  /** True when the record has been soft-deleted in Invoice Ninja */
  is_deleted?: boolean;
  /**
   * Second custom field value — used to store the "Unidad Vivienda" (Housing Unit)
   * label that appears on the AR chart.
   */
  custom_value2?: string;
  /**
   * Contacts embedded in the client object.
   * Available when the API is called with `include: 'contacts'` or by default in IN v5.
   */
  contacts?: ClientContact[];
}

/**
 * Client Group interface (Invoice Ninja "Group Settings")
 */
export interface ClientGroup {
  id: string;
  name: string;
}

/**
 * Vendor interface
 */
export interface Vendor {
  id: string;
  name: string;
}

/**
 * Expense Category interface
 */
export interface ExpenseCategory {
  id: string;
  name: string;
}

/**
 * Invoice interface (represents income)
 */
export interface Invoice {
  id?: string;
  client_id?: string;
  amount: number;
  date?: string;
  invoice_date?: string;
  public_notes?: string;
  number?: string;
  client_name?: string;
  client?: {
    name: string;
  };
  status_id?: string;
  balance?: number;
  paid_to_date?: number;
  /** True when the record has been soft-deleted in Invoice Ninja */
  is_deleted?: boolean;
}

/**
 * Payment interface (represents actual money received)
 */
export interface Payment {
  id?: string;
  number?: string;
  amount: number;
  date?: string;
  payment_date?: string;
  transaction_reference?: string;
  /**
   * Paymentables: the invoices this payment is applied to.
   * Invoice Ninja v5 always returns this array in the payment response;
   * use `paymentables` as the primary source, falling back to `invoices`
   * when working with legacy or custom-transformed data.
   */
  paymentables?: Array<{
    invoice_id: string;
    amount: number;
    refunded?: number;
  }>;
  /** Legacy alias — prefer `paymentables` */
  invoices?: Array<{
    invoice_id: string;
    amount: number;
  }>;
  client_id?: string;
  client_name?: string;
  client?: {
    name: string;
  };
  type_id?: string;
  private_notes?: string;
  invoice_number?: string;
  /** True when the record has been soft-deleted in Invoice Ninja */
  is_deleted?: boolean;
}

/**
 * Filter parameters for clients
 */
export interface ClientFilters {
  per_page?: number;
  page?: number;
  /** Unix timestamp — only return clients updated at or after this time (for incremental sync) */
  updated_at?: number;
  [key: string]: any;
}

/**
 * Filter parameters for expenses
 */
export interface ExpenseFilters {
  per_page?: number;
  page?: number;
  start_date?: string;  // Format: YYYY-MM-DD
  end_date?: string;    // Format: YYYY-MM-DD
  /** Unix timestamp — only return records updated at or after this time (for incremental sync) */
  updated_at?: number;
  [key: string]: any;
}

/**
 * Filter parameters for invoices
 */
export interface InvoiceFilters {
  per_page?: number;
  page?: number;
  status?: string;
  start_date?: string;  // Format: YYYY-MM-DD
  end_date?: string;    // Format: YYYY-MM-DD
  /** Unix timestamp — only return records updated at or after this time (for incremental sync) */
  updated_at?: number;
  [key: string]: any;
}

/**
 * Filter parameters for payments
 */
export interface PaymentFilters {
  per_page?: number;
  page?: number;
  start_date?: string;  // Format: YYYY-MM-DD
  end_date?: string;    // Format: YYYY-MM-DD
  /** Unix timestamp — only return records updated at or after this time (for incremental sync) */
  updated_at?: number;
  [key: string]: any;
}

/**
 * Company settings as returned by the Invoice Ninja `/api/v1/companies` endpoint.
 * Only the fields relevant to the HOA report cover page are declared here.
 */
export interface InvoiceNinjaCompanySettings {
  /** Display name of the company */
  name?: string;
  /** Tax ID / RNC (Registro Nacional del Contribuyente) */
  id_number?: string;
  /** Company website URL */
  website?: string;
  /** Contact e-mail address */
  email?: string;
  /** Address line 1 */
  address1?: string;
  /** Address line 2 */
  address2?: string;
  /** City */
  city?: string;
  /** State / Province */
  state?: string;
  /** Postal code */
  postal_code?: string;
  /** Phone number */
  phone?: string;
  /** Company logo URL — Invoice Ninja v5 also exposes it inside settings */
  company_logo?: string;
}

/**
 * Invoice Ninja company object (subset of fields relevant to the HOA report).
 */
export interface InvoiceNinjaCompany {
  id: string;
  /** Company settings — contains display name, address, contact info, etc. */
  settings?: InvoiceNinjaCompanySettings;
  /**
   * URL of the company logo.
   * May be an absolute URL or a path relative to the IN server base URL.
   */
  logo?: string;
}

/**
 * Invoice Ninja API Client
 * Handles communication with self-hosted Invoice Ninja instance
 */
class InvoiceNinjaClient {
  private baseURL: string;
  private token: string;
  private client: AxiosInstance;
  private perPage: number;

  constructor() {
    this.baseURL = process.env.INVOICE_NINJA_URL || '';
    this.token = process.env.INVOICE_NINJA_TOKEN || '';
    this.perPage = parseInt(process.env.INVOICE_NINJA_PER_PAGE || '250', 10);
    
    if (!this.baseURL || !this.token) {
      throw new Error('Invoice Ninja configuration missing. Please set INVOICE_NINJA_URL and INVOICE_NINJA_TOKEN in .env file');
    }

    this.client = axios.create({
      baseURL: `${this.baseURL}/api/v1`,
      headers: {
        'X-Api-Token': this.token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  }

  /**
   * Generic pagination helper to fetch all pages of data from an endpoint
   */
  private async fetchAllPages<T>(
    endpoint: string,
    filters: Record<string, any> = {},
    onPage?: OnPageFetched
  ): Promise<T[]> {
    const allResults: T[] = [];
    let currentPage = 1;
    let hasMorePages = true;

    // Set default per_page if not provided in filters
    const perPage = filters.per_page || this.perPage;

    while (hasMorePages) {
      const params = {
        ...filters,
        per_page: perPage,
        page: currentPage
      };

      const response = await this.client.get<ApiResponse<T[]>>(endpoint, { params });
      const results = response.data.data || [];
      
      // If we got no results, we're done
      if (results.length === 0) {
        hasMorePages = false;
        break;
      }

      allResults.push(...results);

      // Check if there are more pages using pagination metadata
      const pagination = response.data.meta?.pagination;
      const totalPages = pagination?.total_pages ?? null;

      if (onPage) {
        onPage(currentPage, totalPages, allResults.length);
      }

      if (pagination && pagination.current_page < pagination.total_pages) {
        currentPage++;
      } else {
        hasMorePages = false;
      }
    }

    return allResults;
  }

  /**
   * Get all expenses with optional filters and automatic pagination
   */
  async getExpenses(filters: ExpenseFilters = {}, onPage?: OnPageFetched): Promise<Expense[]> {
    try {
      return await this.fetchAllPages<Expense>('/expenses', filters, onPage);
    } catch (error) {
      console.error('Error fetching expenses:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get a single expense by ID
   */
  async getExpense(expenseId: string): Promise<Expense> {
    try {
      const response = await this.client.get<ApiResponse<Expense>>(`/expenses/${expenseId}`);
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching expense ${expenseId}:`, (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all clients with automatic pagination.
   * Pass `filters.updated_at` (Unix timestamp) to only return clients changed since that time.
   */
  async getClients(filters: ClientFilters = {}, onPage?: OnPageFetched): Promise<Client[]> {
    try {
      return await this.fetchAllPages<Client>('/clients', filters, onPage);
    } catch (error) {
      console.error('Error fetching clients:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all client groups (Invoice Ninja "Group Settings") with automatic pagination
   */
  async getClientGroups(filters: Record<string, any> = {}, onPage?: OnPageFetched): Promise<ClientGroup[]> {
    try {
      return await this.fetchAllPages<ClientGroup>('/group_settings', filters, onPage);
    } catch (error) {
      console.error('Error fetching client groups:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all vendors with automatic pagination
   */
  async getVendors(filters: Record<string, any> = {}, onPage?: OnPageFetched): Promise<Vendor[]> {
    try {
      return await this.fetchAllPages<Vendor>('/vendors', filters, onPage);
    } catch (error) {
      console.error('Error fetching vendors:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get expense categories with automatic pagination
   */
  async getExpenseCategories(filters: Record<string, any> = {}, onPage?: OnPageFetched): Promise<ExpenseCategory[]> {
    try {
      return await this.fetchAllPages<ExpenseCategory>('/expense_categories', filters, onPage);
    } catch (error) {
      console.error('Error fetching expense categories:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Create a new expense
   */
  async createExpense(expenseData: Partial<Expense>): Promise<Expense> {
    try {
      const response = await this.client.post<ApiResponse<Expense>>('/expenses', expenseData);
      return response.data.data;
    } catch (error) {
      console.error('Error creating expense:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Upload a document to a company (makes it publicly visible to portal users).
   *
   * Invoice Ninja v5 stores company documents at `/companies/{id}/upload`.
   * The file is attached as a multipart `file` field with `_method=PUT` so the
   * server treats the POST as a document-update action (same pattern used by
   * expense uploads).
   */
  async uploadCompanyDocument(companyId: string, fileBuffer: Buffer, filename: string): Promise<any> {
    try {
      const formData = new FormData();
      formData.append('file', fileBuffer, filename);
      formData.append('_method', 'PUT');

      const response = await this.client.post(
        `/companies/${companyId}/upload`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'X-Api-Token': this.token,
          },
        }
      );
      return response.data;
    } catch (error) {
      console.error(`Error uploading company document "${filename}" to company ${companyId}:`, (error as Error).message);
      throw error;
    }
  }

  /**
   * Upload a document to an expense
   */
  async uploadExpenseDocument(expenseId: string, fileBuffer: Buffer, filename: string): Promise<any> {
    try {
      const formData = new FormData();
      formData.append('file', fileBuffer, filename);
      formData.append('_method', 'PUT');

      const response = await this.client.post(
        `/expenses/${expenseId}/upload`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'X-Api-Token': this.token
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('Error uploading document:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all invoices with optional filters and automatic pagination
   */
  async getInvoices(filters: InvoiceFilters = {}, onPage?: OnPageFetched): Promise<Invoice[]> {
    try {
      return await this.fetchAllPages<Invoice>('/invoices', filters, onPage);
    } catch (error) {
      console.error('Error fetching invoices:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get a single invoice by ID
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    try {
      const response = await this.client.get<ApiResponse<Invoice>>(`/invoices/${invoiceId}`);
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching invoice ${invoiceId}:`, (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all payments with optional filters and automatic pagination
   */
  async getPayments(filters: PaymentFilters = {}, onPage?: OnPageFetched): Promise<Payment[]> {
    try {
      return await this.fetchAllPages<Payment>('/payments', filters, onPage);
    } catch (error) {
      console.error('Error fetching payments:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get a single payment by ID
   */
  async getPayment(paymentId: string): Promise<Payment> {
    try {
      const response = await this.client.get<ApiResponse<Payment>>(`/payments/${paymentId}`);
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching payment ${paymentId}:`, (error as Error).message);
      throw error;
    }
  }

  /**
   * Fetch the company profile (name, address, contact info, logo) from Invoice Ninja.
   *
   * Invoice Ninja v5 scopes API tokens to a single company, so the `/companies`
   * endpoint returns the company that owns this token.  The response shape can
   * be either a single object or an array depending on the IN version; both
   * cases are handled defensively.
   *
   * Returns `null` when the request fails or no company data is available.
   */
  async getCompanyProfile(): Promise<InvoiceNinjaCompany | null> {
    try {
      // IN v5 returns `{ data: CompanyObject }` (single) or `{ data: CompanyObject[] }` (array).
      const response = await this.client.get<{ data: InvoiceNinjaCompany | InvoiceNinjaCompany[] }>('/companies');
      const raw = response.data?.data;
      if (!raw) return null;
      const company: InvoiceNinjaCompany = Array.isArray(raw) ? raw[0] : raw;
      if (!company?.id) return null;

      // IN v5 sometimes puts the logo inside settings.company_logo instead of the root logo field.
      // Normalise: if root logo is missing, fall back to settings.company_logo.
      if (!company.logo && company.settings?.company_logo) {
        company.logo = company.settings.company_logo;
        console.log('[InvoiceNinjaClient] Logo found in settings.company_logo:', company.logo);
      }

      // Log what we received to help diagnose missing-logo issues.
      console.log('[InvoiceNinjaClient] Company profile received — logo:', company.logo ?? '(none)', '| settings.company_logo:', company.settings?.company_logo ?? '(none)');

      // If the logo URL is relative and non-empty, resolve it against the IN server base URL.
      if (company.logo && company.logo.length > 0 &&
          !company.logo.startsWith('http') && !company.logo.startsWith('data:')) {
        const base = this.baseURL.replace(/\/+$/, '');
        company.logo = `${base}${company.logo.startsWith('/') ? '' : '/'}${company.logo}`;
        console.log('[InvoiceNinjaClient] Resolved relative logo URL to:', company.logo);
      }

      return company;
    } catch (error) {
      console.warn('[InvoiceNinjaClient] Could not fetch company profile:', (error as Error).message);
      return null;
    }
  }
}

export default InvoiceNinjaClient;
