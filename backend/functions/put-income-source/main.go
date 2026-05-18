package main

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	"github.com/google/uuid"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

type incomeSourceRequest struct {
	IncomeSourceID         string                `json:"incomeSourceId"`
	Name                   string                `json:"name"`
	Frequency              string                `json:"frequency"`
	GrossAmount            float64               `json:"grossAmount"`
	FilingStatus           string                `json:"filingStatus"`
	WorkState              string                `json:"workState"`
	Section125Deductions   float64               `json:"section125Deductions"`
	Section125Items        []dbpkg.DeductionItem `json:"section125Items"`
	RetirementDeductions   float64               `json:"retirementDeductions"`
	RetirementItems        []dbpkg.DeductionItem `json:"retirementItems"`
	PreTaxDeductions       float64               `json:"preTaxDeductions"` // legacy
	AdditionalWithholding  float64               `json:"additionalWithholding"`
	DeductionType          string                `json:"deductionType"`
	ItemizedDeductions     float64               `json:"itemizedDeductions"`
	ItemizedDeductionItems []dbpkg.DeductionItem `json:"itemizedDeductionItems"`
	Step3Credits           float64               `json:"step3Credits"`
	Step4aOtherIncome      float64               `json:"step4aOtherIncome"`
	Step4aItems            []dbpkg.DeductionItem `json:"step4aItems"`
	Step4bDeductions       float64               `json:"step4bDeductions"`
	Step4bItems            []dbpkg.DeductionItem `json:"step4bItems"`
	IsActive               bool                  `json:"isActive"`
}

var validFrequencies = map[string]bool{
	"weekly": true, "biweekly": true, "semimonthly": true, "monthly": true,
}

var validFilingStatuses = map[string]bool{
	"single": true, "married_jointly": true, "married_separately": true, "head_of_household": true,
}

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }

	var body incomeSourceRequest
	if err := json.Unmarshal([]byte(req.Body), &body); err != nil {
		return errorResponse(http.StatusBadRequest, "invalid request body"), nil
	}

	if body.Name == "" {
		return errorResponse(http.StatusBadRequest, "name is required"), nil
	}
	if !validFrequencies[body.Frequency] {
		return errorResponse(http.StatusBadRequest, "frequency must be weekly, biweekly, semimonthly, or monthly"), nil
	}
	if !validFilingStatuses[body.FilingStatus] {
		return errorResponse(http.StatusBadRequest, "filingStatus must be single, married_jointly, married_separately, or head_of_household"), nil
	}
	if len(body.WorkState) != 2 {
		return errorResponse(http.StatusBadRequest, "workState must be a 2-letter state code"), nil
	}
	if body.GrossAmount <= 0 {
		return errorResponse(http.StatusBadRequest, "grossAmount must be greater than 0"), nil
	}
	if body.IncomeSourceID == "" {
		body.IncomeSourceID = uuid.NewString()
	}
	if body.DeductionType == "" {
		body.DeductionType = "standard"
	}
	if body.DeductionType != "standard" && body.DeductionType != "itemized" {
		return errorResponse(http.StatusBadRequest, "deductionType must be 'standard' or 'itemized'"), nil
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	source := dbpkg.IncomeSource{
		UserID:                 plaidclient.UserID(),
		IncomeSourceID:         body.IncomeSourceID,
		Name:                   body.Name,
		Frequency:              body.Frequency,
		GrossAmount:            body.GrossAmount,
		FilingStatus:           body.FilingStatus,
		WorkState:              body.WorkState,
		Section125Deductions:   body.Section125Deductions,
		Section125Items:        body.Section125Items,
		RetirementDeductions:   body.RetirementDeductions,
		RetirementItems:        body.RetirementItems,
		PreTaxDeductions:       body.PreTaxDeductions,
		AdditionalWithholding:  body.AdditionalWithholding,
		DeductionType:          body.DeductionType,
		ItemizedDeductions:     body.ItemizedDeductions,
		ItemizedDeductionItems: body.ItemizedDeductionItems,
		Step3Credits:           body.Step3Credits,
		Step4aOtherIncome:      body.Step4aOtherIncome,
		Step4aItems:            body.Step4aItems,
		Step4bDeductions:       body.Step4bDeductions,
		Step4bItems:            body.Step4bItems,
		IsActive:               body.IsActive,
	}

	// Preserve the existing lastNetPay so a save never wipes a previously
	// calculated result.
	if existing, err := dbClient.GetIncomeSource(ctx, plaidclient.UserID(), source.IncomeSourceID); err == nil && existing != nil {
		source.LastNetPay = existing.LastNetPay
	}

	if err := dbClient.PutIncomeSource(ctx, source); err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	respBody, _ := json.Marshal(source)
	return response{StatusCode: http.StatusOK, Body: string(respBody), Headers: jsonHeaders()}, nil
}

func main() { lambda.Start(handler) }

func errorResponse(status int, msg string) response {
	body, _ := json.Marshal(map[string]string{"error": msg})
	return response{StatusCode: status, Body: string(body), Headers: jsonHeaders()}
}

func jsonHeaders() map[string]string {
	return map[string]string{
		"Content-Type":                "application/json",
		"Access-Control-Allow-Origin": "*",
	}
}
