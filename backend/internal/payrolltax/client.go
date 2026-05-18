// Package payrolltax provides a client for payrolltaxapi.com.
package payrolltax

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// PeriodsPerYear returns the number of pay periods in a year for a given frequency.
func PeriodsPerYear(frequency string) float64 {
	switch frequency {
	case "weekly":
		return 52
	case "biweekly":
		return 26
	case "semimonthly":
		return 24
	case "monthly":
		return 12
	default:
		return 26
	}
}

// MapFilingStatus converts internal filing status values to the API's expected values.
func MapFilingStatus(filingStatus string) string {
	switch filingStatus {
	case "married_jointly", "married_separately":
		return "married"
	case "head_of_household":
		return "head_of_household"
	default:
		return "single"
	}
}

// Bracket represents a single tax bracket from the API.
type Bracket struct {
	From float64 `json:"from"`
	To   float64 `json:"to"` // null in JSON means no upper limit; use 0 to indicate unlimited
	Rate float64 `json:"rate"`
}

// TaxEntry is one tax line from the API response.
type TaxEntry struct {
	TaxTypeCode    string    `json:"tax_type_code"`
	Name           string    `json:"name"`
	Category       string    `json:"category"`
	TaxpayerSide   string    `json:"taxpayer_side"`
	RateStructure  string    `json:"rate_structure"`
	Rate           float64   `json:"rate"`
	WageBase       *float64  `json:"wage_base"`
	Brackets       []Bracket `json:"brackets"`
}

// StandardDeduction returns the 2026 federal standard deduction for a filing status.
func StandardDeduction(filingStatus string) float64 {
	switch filingStatus {
	case "married_jointly", "married_separately", "married":
		return 30000
	case "head_of_household":
		return 22500
	default: // single
		return 15000
	}
}

// RatesResponse is the top-level API response from GET /v1/rates/lookup.
type RatesResponse struct {
	Taxes []TaxEntry `json:"taxes"`
}

// NetPayResult is the computed net pay breakdown.
type NetPayResult struct {
	GrossAmount           float64            `json:"grossAmount"`
	Section125Deductions  float64            `json:"section125Deductions"`
	RetirementDeductions  float64            `json:"retirementDeductions"`
	// FicaTaxableWages = gross - section125 (retirement does NOT reduce FICA)
	FicaTaxableWages      float64            `json:"ficaTaxableWages"`
	// IncomeTaxableWages = gross - section125 - retirement
	IncomeTaxableWages    float64            `json:"incomeTaxableWages"`
	DeductionUsed         float64            `json:"deductionUsed"`
	DeductionWarning      string             `json:"deductionWarning,omitempty"`
	Step4aOtherIncome     float64            `json:"step4aOtherIncome,omitempty"`
	Step4bDeductions      float64            `json:"step4bDeductions,omitempty"`
	Step3Credits          float64            `json:"step3Credits,omitempty"`
	Withholdings          map[string]float64 `json:"withholdings"`
	TotalWithheld         float64            `json:"totalWithheld"`
	AdditionalWithholding float64            `json:"additionalWithholding"`
	NetPay                float64            `json:"netPay"`
}

// Lookup calls payrolltaxapi.com and returns the raw rates response.
func Lookup(workState, filingStatus, payPeriod string, grossWages float64, ytdWages float64) (*RatesResponse, error) {
	apiKey := os.Getenv("PAYROLLTAX_API_KEY")
	if apiKey == "" {
		return nil, fmt.Errorf("PAYROLLTAX_API_KEY is not set")
	}

	params := url.Values{}
	params.Set("workState", workState)
	params.Set("payDate", time.Now().Format("2006-01-02"))
	params.Set("filingStatus", MapFilingStatus(filingStatus))
	params.Set("grossWages", strconv.FormatFloat(grossWages, 'f', 2, 64))
	params.Set("ytdWages", strconv.FormatFloat(ytdWages, 'f', 2, 64))
	params.Set("payPeriod", payPeriod)

	reqURL := "https://payrolltaxapi.com/v1/rates/lookup?" + params.Encode()
	req, err := http.NewRequest(http.MethodGet, reqURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("payrolltaxapi returned %d: %s", resp.StatusCode, string(body))
	}

	var rates RatesResponse
	if err := json.Unmarshal(body, &rates); err != nil {
		return nil, fmt.Errorf("failed to parse payrolltaxapi response: %w", err)
	}
	return &rates, nil
}

// ComputeNetPay applies the API rates to the income source parameters and returns a
// full net pay breakdown. The brackets from the API are annualized; we annualize
// taxable wages, apply W-4 adjustments, compute annual tax, then divide by
// periods per year.
//
// Deduction tax treatment:
//   section125 (cafeteria plan: health/dental/vision, HSA, FSA) — reduces both
//     FICA (SS + Medicare) and income tax.
//   retirement (401k/403b/457 traditional) — reduces income tax only, not FICA.
func ComputeNetPay(
	grossAmount float64,
	section125Deductions float64,
	retirementDeductions float64,
	additionalWithholding float64,
	frequency string,
	filingStatus string,
	deductionType string,
	itemizedDeductions float64,
	step3Credits float64,
	step4aOtherIncome float64,
	step4bDeductions float64,
	rates *RatesResponse,
	ytdWages float64,
) NetPayResult {
	periods := PeriodsPerYear(frequency)

	// FICA basis: only section 125 reduces SS/Medicare
	ficaTaxableWages := math.Max(0, grossAmount-section125Deductions)
	// Income tax basis: both buckets reduce taxable income
	incomeTaxableWages := math.Max(0, grossAmount-section125Deductions-retirementDeductions)

	annualIncomeTaxable := incomeTaxableWages * periods

	// Determine which deduction to use for income tax brackets
	stdDeduction := StandardDeduction(filingStatus)
	var deductionUsed float64
	var deductionWarning string

	if deductionType == "itemized" {
		if itemizedDeductions < stdDeduction {
			deductionUsed = stdDeduction
			deductionWarning = fmt.Sprintf(
				"Itemized deductions ($%.2f) are less than the standard deduction ($%.2f). Standard deduction used.",
				itemizedDeductions, stdDeduction,
			)
		} else {
			deductionUsed = itemizedDeductions
		}
	} else {
		deductionUsed = stdDeduction
	}

	// Step 4a: add other non-job income to the annual base before brackets
	// Step 4b: subtract additional deductions (student loan, IRA, etc.)
	// Then subtract the standard/itemized deduction
	// All floored at 0; only applied to graduated (income) taxes, not FICA
	annualIncomeAfterDeduction := math.Max(0,
		annualIncomeTaxable+step4aOtherIncome-step4bDeductions-deductionUsed,
	)

	withholdings := make(map[string]float64)

	for _, t := range rates.Taxes {
		if t.TaxTypeCode == "" {
			continue
		}
		// Only withhold employee-side taxes
		if t.TaxpayerSide != "employee" {
			continue
		}
		var periodTax float64

		switch t.RateStructure {
		case "graduated":
			// Apply income deduction + W-4 adjustments only to graduated (income) taxes
			annualTax := applyBrackets(annualIncomeAfterDeduction, t.Brackets)
			// Step 3: dependent/child tax credits are a federal W-4 concept only.
			// Do not apply them to state income taxes.
			if t.TaxTypeCode == "FED_INCOME_EE" {
				annualTax = math.Max(0, annualTax-step3Credits)
			}
			periodTax = annualTax / periods

		case "wage_base_capped":
			// wage_base nil means it requires accurate YTD tracking — skip it.
			if t.WageBase == nil {
				continue
			}
			// FICA uses ficaTaxableWages (section 125 reduces SS/Medicare)
			if ytdWages >= *t.WageBase {
				periodTax = 0
			} else {
				cappedWages := ficaTaxableWages
				remaining := *t.WageBase - ytdWages
				if remaining < ficaTaxableWages {
					cappedWages = remaining
				}
				periodTax = cappedWages * t.Rate
			}

		case "flat_percent":
			// FICA taxes (SS, Medicare) use ficaTaxableWages.
			// Income taxes (federal, state) use incomeTaxableWages.
			// We detect FICA by category or by well-known code prefix.
			if t.Category == "fica" || strings.HasPrefix(t.TaxTypeCode, "FED_FICA_") {
				periodTax = ficaTaxableWages * t.Rate
			} else {
				periodTax = incomeTaxableWages * t.Rate
			}

		default:
			continue
		}

		periodTax = math.Round(periodTax*100) / 100
		if periodTax > 0 {
			withholdings[t.TaxTypeCode] = periodTax
		}
	}

	totalWithheld := 0.0
	for _, v := range withholdings {
		totalWithheld += v
	}
	totalWithheld = math.Round(totalWithheld*100) / 100

	netPay := math.Round((grossAmount-section125Deductions-retirementDeductions-totalWithheld-additionalWithholding)*100) / 100

	return NetPayResult{
		GrossAmount:           grossAmount,
		Section125Deductions:  section125Deductions,
		RetirementDeductions:  retirementDeductions,
		FicaTaxableWages:      ficaTaxableWages,
		IncomeTaxableWages:    incomeTaxableWages,
		DeductionUsed:         deductionUsed,
		DeductionWarning:      deductionWarning,
		Step4aOtherIncome:     step4aOtherIncome,
		Step4bDeductions:      step4bDeductions,
		Step3Credits:          step3Credits,
		Withholdings:          withholdings,
		TotalWithheld:         totalWithheld,
		AdditionalWithholding: additionalWithholding,
		NetPay:                netPay,
	}
}

// applyBrackets computes tax on annualIncome using graduated brackets.
// Bracket amounts are assumed to be annual.
func applyBrackets(annualIncome float64, brackets []Bracket) float64 {
	tax := 0.0
	for _, b := range brackets {
		if annualIncome <= b.From {
			break
		}
		top := b.To
		if top == 0 {
			top = annualIncome // no upper limit
		}
		taxable := math.Min(annualIncome, top) - b.From
		if taxable > 0 {
			tax += taxable * b.Rate
		}
	}
	return tax
}
