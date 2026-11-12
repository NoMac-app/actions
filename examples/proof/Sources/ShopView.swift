import SwiftUI

struct ShopView: View {
    @Environment(Cart.self) private var cart

    var body: some View {
        NavigationStack {
            List(products) { product in
                HStack {
                    VStack(alignment: .leading) {
                        Text(product.name)
                        Text(product.price).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Add") {
                        cart.items.append(product)
                        cart.ordered = false
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("add-\(product.name)")
                }
            }
            .navigationTitle("Shop")
        }
    }
}
