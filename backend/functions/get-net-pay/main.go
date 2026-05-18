package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	auth "github.com/smcdermott/finance-app/internal/auth"
	dbpkg "github.com/smcdermott/finance-app/internal/db"
	"github.com/smcdermott/finance-app/internal/payrolltax"
	plaidclient "github.com/smcdermott/finance-app/internal/plaid"
)

type response = events.APIGatewayV2HTTPResponse

func handler(ctx context.Context, req events.APIGatewayV2HTTPRequest) (response, error) {
	if deny := auth.Check(req); deny != nil { return *deny, nil }

	sourceID := req.PathParameters["incomeSourceId"]
	if sourceID == "" {
		return errorResponse(http.StatusBadRequest, "incomeSourceId path parameter is required"), nil
	}

	// Optional ytdWages query param (defaults to 0 — caller can pass for accurate SS wage base)
	ytdWages := 0.0
	if s := req.QueryStringParameters["ytdWages"]; s != "" {
		if v, err := strconv.ParseFloat(s, 64); err == nil {
			ytdWages = v
		}
	}

	dbClient, err := dbpkg.New(ctx)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}

	src, err := dbClient.GetIncomeSource(ctx, plaidclient.UserID(), sourceID)
	if err != nil {
		return errorResponse(http.StatusInternalServerError, err.Error()), nil
	}
	if src == nil {
		return errorResponse(http.StatusNotFound, "income source not found"), nil
	}

	rates, err := payrolltax.Lookup(
		src.WorkState,
		src.FilingStatus,
		src.Frequency,
		src.GrossAmount,
		ytdWages,
	)
	if err != nil {
		return errorResponse(http.StatusBadGateway, "payrolltax API error: "+err.Error()), nil
	}

	// Legacy migration: if both new fields are zero, treat old preTaxDeductions
	// as Section 125 (the conservative assumption — fully FICA-exempt).
	section125 := src.Section125Deductions
	retirement := src.RetirementDeductions
	if section125 == 0 && retirement == 0 && src.PreTaxDeductions > 0 {
		section125 = src.PreTaxDeductions
	}

	result := payrolltax.ComputeNetPay(
		src.GrossAmount,
		section125,
		retirement,
		src.AdditionalWithholding,
		src.Frequency,
		src.FilingStatus,
		src.DeductionType,
		src.ItemizedDeductions,
		src.Step3Credits,
		src.Step4aOtherIncome,
		src.Step4bDeductions,
		rates,
		ytdWages,
	)

	// Persist the result so it survives page reloads.
	stored := dbpkg.NetPayResult{
		GrossAmount:           result.GrossAmount,
		Section125Deductions:  result.Section125Deductions,
		RetirementDeductions:  result.RetirementDeductions,
		FicaTaxableWages:      result.FicaTaxableWages,
		IncomeTaxableWages:    result.IncomeTaxableWages,
		DeductionUsed:         result.DeductionUsed,
		DeductionWarning:      result.DeductionWarning,
		Step4aOtherIncome:     result.Step4aOtherIncome,
		Step4bDeductions:      result.Step4bDeductions,
		Step3Credits:          result.Step3Credits,
		Withholdings:          result.Withholdings,
		TotalWithheld:         result.TotalWithheld,
		AdditionalWithholding: result.AdditionalWithholding,
		NetPay:                result.NetPay,
	}
	_ = dbClient.SaveIncomeSourceNetPay(ctx, plaidclient.UserID(), sourceID, stored)

	body, _ := json.Marshal(result)
	return response{StatusCode: http.StatusOK, Body: string(body), Headers: jsonHeaders()}, nil
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
